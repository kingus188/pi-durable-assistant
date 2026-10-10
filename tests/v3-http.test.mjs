import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}
async function post(origin, path, data = {}) {
  const response = await fetch(origin + path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data),
  });
  const raw = await response.text();
  if (!raw) throw new Error("接口返回空响应：" + path + " HTTP " + response.status);
  const body = JSON.parse(raw);
  assert.equal(response.status < 400, true, JSON.stringify(body));
  return body;
}
async function launch(dataDir, port) {
  let logs = "";
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, LLM_API: "faux", DATA_DIR: dataDir, PORT: String(port), NODE_ENV: "test", DEMO_PASSWORD: "", NOTIFY_MODE: "off" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { logs += chunk.toString(); });
  child.stderr.on("data", (chunk) => { logs += chunk.toString(); });
  const origin = "http://127.0.0.1:" + port;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error("服务启动失败：" + logs);
    try { const r = await fetch(origin + "/api/info"); if (r.ok) return { child, origin, getLogs: () => logs }; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill("SIGKILL");
  throw new Error("服务启动超时：" + logs);
}
async function stop(child) {
  if (child.exitCode !== null) return;
  await new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill("SIGTERM");
    setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 2000).unref();
  });
}
test("创建、管理、持久化和导出接口（无需 API Key）", { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-v3-"));
  let app;
  try {
    app = await launch(dir, await freePort());
    const { id } = await post(app.origin, "/api/conversations");
    const prefix = "/api/conversations/" + id;
    const created = await post(app.origin, prefix + "/schedules", {
      text: "检查项目", minutesFromNow: 10, everyMinutes: 30, requestId: "test-schedule",
    });
    assert.equal(created.item.status, "active");
    const dupe = await post(app.origin, prefix + "/schedules", {
      text: "检查项目", minutesFromNow: 10, everyMinutes: 30, requestId: "test-schedule",
    });
    assert.equal(dupe.item.id, created.item.id);
    await post(app.origin, prefix + "/schedules/" + created.item.id + "/pause");
    await post(app.origin, prefix + "/schedules/" + created.item.id + "/resume");
    await post(app.origin, prefix + "/schedules/" + created.item.id + "/cancel");
    const management = await (await fetch(app.origin + prefix + "/management")).json();
    assert.equal(management.schedules.length, 1);
    assert.equal(management.schedules[0].status, "cancelled");
    const bg = await post(app.origin, prefix + "/background", {
      text: "执行一项可取消的任务", requestId: "test-stop-background",
    });
    await post(app.origin, prefix + "/background/" + bg.item.id + "/stop");
    const afterStop = await (await fetch(app.origin + prefix + "/management")).json();
    assert.equal(afterStop.background.find((x) => x.id === bg.item.id).status, "cancelled");
    const exported = await fetch(app.origin + prefix + "/export.md");
    assert.equal(exported.status, 200);
    assert.match(await exported.text(), /Pi Durable 会话/);
    await stop(app.child);
    app = await launch(dir, await freePort());
    const afterRestart = await (await fetch(app.origin + prefix + "/management")).json();
    assert.equal(afterRestart.schedules[0].id, created.item.id);
  } catch (error) {
    console.error("集成测试异常时服务输出：", app?.getLogs?.());
    throw error;
  } finally {
    if (app) await stop(app.child);
    await rm(dir, { recursive: true, force: true });
  }
});

test("计划触发与后台子 Agent 在进程重启后继续完成", { timeout: 50000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-v3-recovery-"));
  let app;
  try {
    app = await launch(dir, await freePort());
    const { id } = await post(app.origin, "/api/conversations");
    const prefix = "/api/conversations/" + id;
    const scheduled = await post(app.origin, prefix + "/schedules", {
      text: "完成一次检查", minutesFromNow: 0.25, requestId: "schedule-recovery",
    });
    const background = await post(app.origin, prefix + "/background", {
      text: "执行一个十秒的演示任务并报告", requestId: "background-recovery",
    });
    await new Promise((resolve) => setTimeout(resolve, 700));
    await stop(app.child);
    app = await launch(dir, await freePort());
    let latest;
    for (let i = 0; i < 145; i++) {
      latest = await (await fetch(app.origin + prefix + "/management")).json();
      const job = latest.background.find((x) => x.id === background.item.id);
      const schedule = latest.schedules.find((x) => x.id === scheduled.item.id);
      if (job?.status === "done" && schedule?.status === "completed") break;
      if (job?.status === "failed") throw new Error("后台任务失败：" + job.result);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const job = latest.background.find((x) => x.id === background.item.id);
    const schedule = latest.schedules.find((x) => x.id === scheduled.item.id);
    assert.equal(job.status, "done", "后台 Agent 未完成：" + JSON.stringify(job));
    assert.ok(job.conversationId, "未记录子会话");
    assert.equal(schedule.status, "completed", "计划未触发：" + JSON.stringify(schedule));
    assert.equal(schedule.runs, 1, "任务必须恰好触发一次");
  } catch (error) {
    console.error("崩溃恢复测试服务输出：", app?.getLogs?.());
    throw error;
  } finally {
    if (app) await stop(app.child);
    await rm(dir, { recursive: true, force: true });
  }
});

test("恶意请求体与保留的幂等键返回 400，服务仍可运行", { timeout: 20000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-v3-validation-"));
  let app;
  try {
    app = await launch(dir, await freePort());
    const { id } = await post(app.origin, "/api/conversations");
    const prefix = "/api/conversations/" + id;
    for (const malformed of ["null", "[]", '"hello"', "not-json"]) {
      const response = await fetch(app.origin + prefix + "/schedules", {
        method: "POST", headers: { "content-type": "application/json" }, body: malformed,
      });
      assert.equal(response.status, 400, "should reject " + malformed);
    }
    for (const invalidKey of ["__proto__", "constructor", "prototype"]) {
      const response = await fetch(app.origin + prefix + "/schedules", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "test", minutesFromNow: 1, requestId: invalidKey }),
      });
      assert.equal(response.status, 400, invalidKey);
    }
    const valid = await post(app.origin, prefix + "/schedules", {
      text: "valid", minutesFromNow: 1, requestId: "valid-1",
    });
    assert.equal(valid.item.status, "active");
    await post(app.origin, prefix + "/schedules/" + valid.item.id + "/cancel");
  } finally {
    if (app) await stop(app.child);
    await rm(dir, { recursive: true, force: true });
  }
});
