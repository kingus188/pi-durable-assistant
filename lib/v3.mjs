// v3：周期任务、后台子 Agent、管理操作和可选 webhook。保留 1.1.0 API。
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { Type } from "@earendil-works/pi-ai";
import { AssistantEntry, configure, defineDoc, defineExtension, defineTask, defineTool } from "@earendil-works/pi-durable";
import { nextOccurrence, normalizeSchedule, scheduleMatches } from "./v3-utils.mjs";

const resultText = (value) => ({ content: [{ type: "text", text: value }] });
const finish = (result = null) => ({ status: "terminal", outcome: { status: "completed", result } });

export const Schedules = defineDoc({
  kind: "app.v3.schedules", version: 1, scope: "conversation", fork: "initial",
  initial: () => ({ items: [], applied: {} }),
});
export const BackgroundJobs = defineDoc({
  kind: "app.v3.background", version: 1, scope: "conversation", fork: "initial",
  initial: () => ({ items: [], applied: {} }),
});

// 可选通知。发送失败只记录告警，不影响持久任务提交。
// 外部接收方可依据 X-Pi-Event-ID 去重；传输采用至少一次语义。
export async function notifyEvent({ id, type, text, failed = false }) {
  const url = process.env.NOTIFY_WEBHOOK_URL;
  const mode = process.env.NOTIFY_MODE || "errors";
  if (!url || mode === "off" || (mode === "errors" && !failed)) return;
  const kind = process.env.NOTIFY_WEBHOOK_KIND || "generic";
  const body = kind === "feishu"
    ? { msg_type: "text", content: { text: text } }
    : { id, type, text, failed, at: new Date().toISOString() };
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pi-event-id": String(id) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
      redirect: "error",
    });
    if (!response.ok) throw new Error("HTTP " + response.status);
  } catch (error) {
    console.error("Webhook 推送失败（可能重复或遗漏，请检查接收方幂等）：", error.message);
  }
}

export const ScheduleTask = defineTask({
  name: "app.v3.schedule", version: 1,
  initial: () => ({ phase: "sleep" }),
  phases: {
    sleep: async (task, runtime, context) => {
      const ms = task.input.at - Date.now();
      if (ms > 0) await sleep(ms, undefined, { signal: runtime.signal });
      await runtime.commit(() => ({ status: "running", checkpoint: { phase: "fire" } }), context);
    },
    fire: async (task, runtime, context) => {
      // 取消、暂停或修改后，旧任务到期时不会产生消息。
      let shouldFire = false;
      await runtime.commit(async (tx) => {
        const item = (await tx.doc(Schedules, runtime.conversationId)).items.find((it) => it.id === task.input.scheduleId);
        shouldFire = scheduleMatches(item, task.input);
        return shouldFire ? { status: "running", checkpoint: { phase: "deliver" } } : finish("已跳过过期任务");
      }, context);
    },
    deliver: async (task, runtime, context) => {
      const parent = await runtime.conversation(runtime.conversationId, context);
      await parent.submit({
        type: "input", content: "[计划任务] " + task.input.text,
        requestId: "schedule:" + task.input.scheduleId + ":" + task.input.at,
        whenBusy: "followUp",
      }, context);
      await runtime.commit(async (tx) => {
        const doc = await tx.doc(Schedules, runtime.conversationId);
        const item = doc.items.find((it) => it.id === task.input.scheduleId);
        if (scheduleMatches(item, task.input)) {
          item.runs += 1;
          item.lastRunAt = task.input.at;
          const nextAt = nextOccurrence(task.input.at, item.everyMinutes);
          if (nextAt !== null) {
            item.nextAt = nextAt;
            item.revision += 1;
            item.jobId = await tx.createTask(ScheduleTask, {
              scheduleId: item.id, text: item.text, at: nextAt, revision: item.revision,
            }, { ownership: { kind: "conversation" }, background: true });
          } else {
            item.nextAt = null;
            item.status = "completed";
          }
        }
        return finish();
      }, context);
      await notifyEvent({ id: "schedule:" + task.input.scheduleId + ":" + task.input.at,
        type: "schedule", text: "计划任务已触发：" + task.input.text });
    },
  },
  abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

export async function scheduleInTx(tx, conversationId, input, requestId) {
  const doc = await tx.doc(Schedules, conversationId);
  if (requestId && doc.applied?.[requestId]) return doc.applied[requestId];
  const normalized = normalizeSchedule(input);
  const item = {
    id: randomUUID(), text: normalized.text, nextAt: normalized.at,
    everyMinutes: normalized.everyMinutes, runs: 0, lastRunAt: null,
    status: "active", revision: 1, createdAt: Date.now(),
  };
  item.jobId = await tx.createTask(ScheduleTask, {
    scheduleId: item.id, text: item.text, at: item.nextAt, revision: item.revision,
  }, { ownership: { kind: "conversation" }, background: true });
  doc.items.push(item);
  if (requestId) (doc.applied ??= {})[requestId] = item;
  return item;
}

export async function manageScheduleInTx(tx, conversationId, id, action) {
  const item = (await tx.doc(Schedules, conversationId)).items.find((it) => it.id === id);
  if (!item) throw new Error("计划任务不存在");
  if (action === "cancel" && item.status !== "completed") {
    item.status = "cancelled";
    item.revision += 1;
  } else if (action === "pause" && item.status === "active") {
    item.status = "paused";
    item.revision += 1;
  } else if (action === "resume" && item.status === "paused") {
    item.status = "active";
    item.revision += 1;
    // 恢复时保留未来的截止时间；过去的截止时间改成 1 分钟后。
    item.nextAt = Math.max(item.nextAt || 0, Date.now() + 60000);
    item.jobId = await tx.createTask(ScheduleTask, {
      scheduleId: item.id, text: item.text, at: item.nextAt, revision: item.revision,
    }, { ownership: { kind: "conversation" }, background: true });
  } else {
    throw new Error("当前状态不能执行该操作");
  }
  return item;
}

export const BackgroundTask = defineTask({
  name: "app.v3.background-agent", version: 1,
  initial: () => ({ phase: "run" }),
  phases: {
    run: async (task, runtime, context) => {
      const childId = await runtime.commit(async (tx) => {
        const existing = (await tx.scanConversations({ ownerTaskId: task.id }, 1)).items[0];
        if (existing !== undefined) return existing.id;
        const child = await tx.createConversation({ ownership: { kind: "task", taskId: task.id } });
        await configure(tx, child.id, {
          extensions: { remove: [V3] },
          instructions: "你是后台子 Agent。只执行交给你的任务，简洁汇报结果，不要再委派后台子 Agent。",
        });
        const item = (await tx.doc(BackgroundJobs, runtime.conversationId)).items.find((it) => it.id === task.input.jobId);
        if (item) item.conversationId = child.id;
        return child.id;
      }, context);
      const child = await runtime.conversation(childId, context);
      const submission = await child.submit({
        type: "input", content: task.input.text, requestId: "background:" + task.input.jobId,
      }, context);
      const settled = await submission.wait(context);
      let answer = "";
      if (settled.status === "done" && settled.type === "input") {
        answer = await runtime.commit(async (tx) => {
          const parts = (await tx.entry(AssistantEntry, settled.answer))?.model?.[0]?.content ?? [];
          return parts.filter((p) => p.type === "text").map((p) => p.text).join("").slice(0, 4000);
        }, context);
      }
      const failed = settled.status !== "done";
      const summary = failed ? "后台子 Agent 未完成：" + (settled.reason || settled.status) : (answer || "任务已完成，没有文字结果");
      // 父会话的 requestId 固定，崩溃后重放不会产生重复报告。
      const parent = await runtime.conversation(runtime.conversationId, context);
      await parent.submit({
        type: "input", content: "[后台任务结果] " + task.input.text + "\n" + summary,
        requestId: "background-report:" + task.input.jobId, whenBusy: "followUp",
      }, context);
      await runtime.commit(async (tx) => {
        const item = (await tx.doc(BackgroundJobs, runtime.conversationId)).items.find((it) => it.id === task.input.jobId);
        if (item && item.status !== "cancelled") {
          item.status = failed ? "failed" : "done";
          item.result = summary;
          item.finishedAt = Date.now();
        }
        return finish();
      }, context);
      await notifyEvent({ id: "background:" + task.input.jobId, type: "background",
        text: (failed ? "后台任务失败：" : "后台任务完成：") + task.input.text + "\n" + summary, failed });
    },
  },
  abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

export async function backgroundInTx(tx, conversationId, input, requestId) {
  const doc = await tx.doc(BackgroundJobs, conversationId);
  if (requestId && doc.applied?.[requestId]) return doc.applied[requestId];
  const text = String(input?.text ?? "").trim();
  if (!text || text.length > 4000) throw new Error("后台任务说明必须是 1～4000 字");
  const item = { id: randomUUID(), text, status: "running", conversationId: null, createdAt: Date.now(), result: null };
  item.taskId = await tx.createTask(BackgroundTask, { jobId: item.id, text },
    { ownership: { kind: "conversation" }, background: true });
  doc.items.push(item);
  if (requestId) (doc.applied ??= {})[requestId] = item;
  return item;
}

export const V3 = defineExtension({
  name: "v3-task-center",
  tasks: [ScheduleTask, BackgroundTask],
  tools: [
    defineTool({
      name: "schedule_task", replay: "safe",
      description: "在指定分钟后执行任务，可按固定间隔重复；everyMinutes 为 0 时只执行一次",
      parameters: Type.Object({
        text: Type.String(), minutesFromNow: Type.Number(),
        everyMinutes: Type.Optional(Type.Number()),
      }),
      execute: async (args, api, context) => {
        const item = await api.commit((tx) => scheduleInTx(tx, api.conversationId, args, "tool:" + api.callId), context);
        return resultText("计划已创建：" + item.id);
      },
    }),
    defineTool({
      name: "delegate_background", replay: "safe",
      description: "把一项独立工作交给可跨进程恢复的后台子 Agent，立即返回任务编号，不等待它完成",
      parameters: Type.Object({ text: Type.String() }),
      execute: async (args, api, context) => {
        const item = await api.commit((tx) => backgroundInTx(tx, api.conversationId, args, "tool:" + api.callId), context);
        return resultText("后台子 Agent 已启动：" + item.id);
      },
    }),
  ],
});
