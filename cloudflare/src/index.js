/**
 * Cloudflare edition of xiaomoBoy/pi-durable-assistant (minimal first release).
 * Real Pi Durable + PiHarness; the only model is Pi AI's scripted faux provider.
 * No API key, Containers, or paid AI model is required.
 */
import { Agent } from 'agents';
import { PiHarness } from 'agents/harness/pi';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { Type } from '@earendil-works/pi-ai';
import { createRegistry, defineExtension, defineTool, Harness } from '@earendil-works/pi-durable';

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
  const timer = setTimeout(done, ms);
  function done() { signal?.removeEventListener('abort', cancel); resolve(); }
  function cancel() { clearTimeout(timer); signal?.removeEventListener('abort', cancel); reject(signal.reason ?? new Error('aborted')); }
  signal?.addEventListener('abort', cancel, { once: true });
});

// Kept from the original project's wait_seconds design: memo persists a deadline.
const checkpointWait = defineTool({
  name: 'checkpoint_wait',
  description: 'Pause briefly while persisting the deadline so Pi can resume after eviction.',
  parameters: Type.Object({ seconds: Type.Number() }),
  replay: 'safe',
  execute: async ({ seconds }, api, context) => {
    const duration = Math.min(25, Math.max(1, Math.round(seconds)));
    const deadline = await api.memo('deadline', Date.now() + duration * 1000, context);
    while (Date.now() < deadline) {
      await sleep(Math.min(900, Math.max(1, deadline - Date.now())), context.abortSignal);
    }
    return { content: [{ type: 'text', text: '已到达原定截止时间，任务继续执行。' }] };
  },
});

// Uses the last user turn rather than in-memory step count: deterministic after restart.
export function fauxScript(context) {
  const messages = context.messages ?? [];
  const lastUser = messages.findLastIndex((m) => m.role === 'user');
  const replies = messages.slice(lastUser + 1).filter((m) => m.role === 'assistant').length;
  if (replies === 0) {
    return fauxAssistantMessage(
      [fauxToolCall('checkpoint_wait', { seconds: 12 })],
      { stopReason: 'toolUse' },
    );
  }
  return fauxAssistantMessage('任务完成：Pi Durable 已保存任务检查点并继续执行。本次未调用真实 AI 模型。');
}

function extractText(record) {
  const content = record?.model?.[0]?.content ?? record?.content ?? [];
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((part) => part?.type === 'text').map((part) => part.text ?? '').join('');
}

export function simplifyTranscript(records) {
  return (records ?? []).flatMap((record) => {
    if (record.kind !== 'pi.user' && record.kind !== 'pi.assistant') return [];
    const text = extractText(record).trim();
    if (!text) return [];
    return [{ id: String(record.id ?? ''), role: record.kind === 'pi.user' ? 'user' : 'assistant', text }];
  });
}

export class Assistant extends Agent {
  constructor(ctx, env) {
    super(ctx, env);
    const faux = fauxProvider();
    faux.setResponses(Array(300).fill(fauxScript));
    const registry = createRegistry();
    registry.install(defineExtension({
      name: 'pi-durable-edge',
      tools: [checkpointWait],
      sections: [{ key: 'preamble', render: () => '这是 Pi Durable Edge 的免费模拟模式。先使用 checkpoint_wait 工具，随后给出固定的完成提示。', tag: false }],
    }));
    this.harness = new PiHarness({
      harness: ({ storage, context }) => {
        const models = createModels();
        models.setProvider(faux.provider);
        return Harness.open(storage, { models, registry }, context);
      },
      defaults: { model: faux.getModel() },
    });
    this.lifecycle.use(this.harness);
  }

  ensureTable() {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS edge_reminders (id TEXT PRIMARY KEY, text TEXT NOT NULL, due_at INTEGER NOT NULL, status TEXT NOT NULL, fired_at INTEGER)"
    );
  }

  async startChat(text, operationId) {
    if (typeof text !== 'string' || text.trim().length < 1 || text.length > 1000) throw new Error('消息长度须为 1–1000 字');
    if (typeof operationId !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(operationId)) throw new Error('operationId 格式错误');
    const receipt = await this.harness.submit(text.trim(), { operationId });
    return { operationId: receipt.operationId, accepted: receipt.accepted };
  }

  async snapshot() {
    this.ensureTable();
    const [entries, pending] = await Promise.all([
      this.harness.session().messages(),
      this.harness.pending(),
    ]);
    const reminders = this.ctx.storage.sql.exec(
      'SELECT id, text, due_at AS dueAt, status, fired_at AS firedAt FROM edge_reminders ORDER BY due_at DESC LIMIT 20'
    ).toArray();
    return { messages: simplifyTranscript(entries), pending, reminders };
  }

  async createReminder(text, seconds) {
    if (typeof text !== 'string' || !text.trim() || text.length > 200) throw new Error('提醒内容须为 1–200 字');
    if (!Number.isInteger(seconds) || seconds < 5 || seconds > 3600) throw new Error('延迟必须在 5–3600 秒之间');
    this.ensureTable();
    const id = crypto.randomUUID();
    const dueAt = Date.now() + seconds * 1000;
    this.ctx.storage.sql.exec(
      'INSERT INTO edge_reminders (id, text, due_at, status, fired_at) VALUES (?, ?, ?, ?, NULL)',
      id, text.trim(), dueAt, 'scheduled'
    );
    try {
      await this.schedule(seconds, 'fireReminder', { id });
    } catch (error) {
      this.ctx.storage.sql.exec("UPDATE edge_reminders SET status = 'failed' WHERE id = ?", id);
      throw error;
    }
    return { id, text: text.trim(), dueAt, status: 'scheduled' };
  }

  // Invoked by Agent's persisted scheduler / Durable Object alarm even without open browsers.
  async fireReminder({ id }) {
    this.ensureTable();
    this.ctx.storage.sql.exec(
      "UPDATE edge_reminders SET status = 'fired', fired_at = ? WHERE id = ? AND status = 'scheduled'",
      Date.now(), id
    );
  }
}

function json(payload, status = 200) {
  return Response.json(payload, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

function authenticate(request, token) {
  return typeof token === 'string' && token.length >= 24 && request.headers.get('authorization') === 'Bearer ' + token;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (!env.ACCESS_TOKEN || env.ACCESS_TOKEN.length < 24) return json({ error: '尚未配置 ACCESS_TOKEN（至少 24 字符）' }, 503);
    if (!authenticate(request, env.ACCESS_TOKEN)) return json({ error: '访问令牌无效' }, 401);
    const agent = env.Assistant.getByName('owner');
    try {
      if (request.method === 'GET' && url.pathname === '/api/state') return json(await agent.snapshot());
      if (request.method === 'POST' && url.pathname === '/api/chat') {
        const body = await request.json();
        return json(await agent.startChat(body?.text, body?.operationId), 202);
      }
      if (request.method === 'POST' && url.pathname === '/api/reminders') {
        const body = await request.json();
        return json(await agent.createReminder(body?.text, body?.seconds), 201);
      }
      return json({ error: 'Not found' }, 404);
    } catch (error) {
      // Avoid leaking internal stack traces or credentials to public clients.
      console.error('edge api failed', error);
      return json({ error: '请求失败，请查看 Workers 日志并检查输入和配额。' }, 500);
    }
  },
};
