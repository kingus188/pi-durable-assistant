// HTTP 服务：静态页面、JSON 接口和 SSE 推送
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { config, Delegations, Index, Meta, Notes, openAgent, Reminders } from "./lib/agent.mjs";

const { harness, root, agentModel, modelLabel } = await openAgent(ctx);
const startedAt = new Date().toISOString();
// 整个会话库的任务图（每个持久任务的状态），所有 SSE 连接共用一份
const taskGraph = await harness.taskGraph(ctx);
const indexHtml = new URL("./public/index.html", import.meta.url);

class HttpError extends Error {
	constructor(status, message) {
		super(message);
		this.status = status;
	}
}

// 任何对外输出（页面、日志）前都抹掉 Key，防止中转把 Key 回显在报错里
const secret = process.env.LLM_API_KEY || "";
const redact = (value) => (secret.length >= 8 ? String(value).replaceAll(secret, "***") : String(value));

// 存储提交失败后 Session 不可再用，退出进程交给 Docker 或 dev.sh 拉起，重开后从存储恢复
function exitIfFatal(error) {
	if (/poisoned|SessionFailed|session_failed/i.test(`${error?.name} ${error?.message}`)) {
		console.error("存储不可用，进程退出等待重启：", redact(error.message));
		process.exit(1);
	}
}

function sendJson(res, status, body) {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	res.end(JSON.stringify(body));
}

async function readBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > 100_000) throw new HttpError(413, "请求太大");
		chunks.push(chunk);
	}
	if (size === 0) return {};
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new HttpError(400, "请求不是合法 JSON");
	}
}

function authorized(req) {
	if (!config.password) return true;
	const header = req.headers.authorization || "";
	if (!header.startsWith("Basic ")) return false;
	const given = Buffer.from(Buffer.from(header.slice(6), "base64").toString("utf8"));
	const expected = Buffer.from(`demo:${config.password}`);
	return given.length === expected.length && timingSafeEqual(given, expected);
}

// 写操作只接受同源请求，挡住跨站页面借浏览器缓存的口令发请求
function sameOrigin(req) {
	const origin = req.headers.origin;
	if (!origin) return true;
	try {
		return new URL(origin).host === req.headers.host;
	} catch {
		return false;
	}
}

async function getConversation(id) {
	const conversation = Number.isInteger(id) && id !== root.id ? await harness.conversation(id, ctx) : undefined;
	if (!conversation) throw new HttpError(404, "会话不存在");
	return conversation;
}

// 建会话和登记会话列表放在同一个事务里，不会出现列表里看不到的会话
const registerIn = (item) => async (tx, conversationId) => {
	(await tx.doc(Index)).items.push({ id: conversationId, createdAt: new Date().toISOString(), ...item });
};

async function updateTitle(id, title) {
	await root.commit(async (tx) => {
		const item = (await tx.doc(Index)).items.find((i) => i.id === id);
		if (item && item.title === "新对话") item.title = title;
	}, ctx);
}

const contentText = (content) =>
	typeof content === "string" ? content : (content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("");

// 把 Harness 的视图压成前端要的样子
async function simplifyView(conversationId, value) {
	const entries = [];
	for (const entry of value.entries ?? []) {
		const message = entry.model?.[0];
		if (!message) continue;
		if (entry.kind === "pi.user") {
			entries.push({ id: entry.id, kind: "user", text: contentText(message.content) });
		} else if (entry.kind === "pi.assistant") {
			const parts = Array.isArray(message.content) ? message.content : [];
			entries.push({
				id: entry.id,
				kind: "assistant",
				text: contentText(parts),
				toolCalls: parts.filter((p) => p.type === "toolCall").map((p) => ({ id: p.id, name: p.name, args: p.arguments })),
				error: message.stopReason === "error" ? redact(message.errorMessage || "模型调用失败") : undefined,
			});
		} else if (entry.kind === "pi.tool-result") {
			entries.push({
				id: entry.id,
				kind: "tool",
				toolCallId: message.toolCallId,
				name: message.toolName,
				// 去掉 Harness 给错误结果包的 <harness> 标签，前端只显示人话
				text: contentText(message.content).replace(/<\/?harness>/g, "").replace(/^\s*\[error\]\s*/m, "").trim(),
				isError: Boolean(message.isError),
			});
		}
	}
	const live = value.docs?.["pi.live"] ?? {};
	const notes = (await harness.snapshot(Notes, conversationId, ctx)) ?? {};
	const reminders = (await harness.snapshot(Reminders, conversationId, ctx))?.items ?? [];
	const subagents = (await harness.snapshot(Delegations, conversationId, ctx))?.items ?? [];
	const children = (await harness.snapshot(Index, ctx))?.children ?? {};
	// 本会话和它派出的子会话里还活着的任务
	const mine = new Set([conversationId, ...subagents.map((a) => a.conversationId)]);
	const tasks = Object.values(taskGraph.value?.tasks ?? {})
		.filter((t) => mine.has(t.conversationId))
		.map((t) => ({
			id: t.id,
			kind: t.kind,
			status: t.state.status,
			phase: t.state.phase ?? null,
			owner: t.owner ?? null,
			background: t.background,
			conversationId: t.conversationId,
			conversations: t.conversations,
		}));
	return {
		conversationId,
		entries,
		live,
		busy: Object.keys(live).length > 0,
		inbox: value.docs?.["pi.inbox"]?.items?.length ?? 0,
		notes: { todos: notes.todos ?? [], memos: notes.memos ?? [] },
		usage: value.docs?.["pi.usage"] ?? null,
		tasks,
		reminders: [...reminders].sort((a, b) => a.at - b.at).map(({ id, text, at, status }) => ({ id, text, at, status })),
		subagents,
		parentId: children[conversationId] ?? null,
	};
}

async function streamEvents(req, res, conversation) {
	res.writeHead(200, {
		"content-type": "text/event-stream; charset=utf-8",
		"cache-control": "no-store",
		connection: "keep-alive",
		"x-accel-buffering": "no",
	});
	// 先挂好清理，异步准备期间断开也能释放
	let closed = false;
	let view = null;
	let unsubscribe = null;
	let unsubscribeGraph = null;
	let timer = null;
	const ping = setInterval(() => {
		if (res.writableLength === 0) res.write(": ping\n\n");
	}, 15_000);
	const cleanup = () => {
		if (closed) return;
		closed = true;
		clearInterval(ping);
		clearTimeout(timer);
		unsubscribe?.();
		unsubscribeGraph?.();
		view?.dispose();
	};
	res.on("close", cleanup);

	// 同一连接同时只推一份；推送期间来的变化合并成下一份最新的。客户端读得慢时等 drain，不堆积旧快照
	let pushing = false;
	let dirty = false;
	const push = async () => {
		timer = null;
		if (closed || !view) return;
		if (pushing) {
			dirty = true;
			return;
		}
		pushing = true;
		try {
			do {
				dirty = false;
				const payload = await simplifyView(conversation.id, view.value);
				if (closed) return;
				if (!res.write(`event: view\ndata: ${JSON.stringify(payload)}\n\n`)) {
					await new Promise((resolve) => res.once("drain", resolve).once("close", resolve));
				}
			} while (dirty && !closed);
		} catch (error) {
			console.error("推送失败：", redact(error.message));
			exitIfFatal(error);
		} finally {
			pushing = false;
		}
	};
	const schedule = () => {
		if (!timer && !closed) timer = setTimeout(push, 150);
	};

	view = await conversation.viewState(ctx);
	if (closed) return view.dispose();
	unsubscribe = view.subscribe(schedule);
	unsubscribeGraph = taskGraph.subscribe(schedule);
	await push();
}

async function route(req, res) {
	const url = new URL(req.url, "http://localhost");
	const path = url.pathname;
	const method = req.method;
	if (method !== "GET" && !sameOrigin(req)) throw new HttpError(403, "只接受同源请求");

	if (method === "GET" && path === "/") {
		res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
		return res.end(await readFile(indexHtml));
	}
	if (method === "GET" && path === "/api/info") {
		const meta = await harness.snapshot(Meta, ctx);
		return sendJson(res, 200, { model: modelLabel, api: config.api, pid: process.pid, startedAt, boots: meta?.boots ?? 0 });
	}
	if (path === "/api/conversations") {
		if (method === "GET") {
			const index = await harness.snapshot(Index, ctx);
			return sendJson(res, 200, [...(index?.items ?? [])].reverse());
		}
		if (method === "POST") {
			const conversation = await harness.createConversation(
				{ ownership: { kind: "ownerless" }, agent: { model: agentModel }, init: registerIn({ title: "新对话" }) },
				ctx,
			);
			return sendJson(res, 201, { id: conversation.id });
		}
	}
	if (method === "POST" && path === "/api/crash") {
		sendJson(res, 200, { ok: true });
		console.log("收到模拟崩溃请求，200ms 后退出");
		setTimeout(() => process.exit(1), 200);
		return;
	}

	const match = path.match(/^\/api\/conversations\/(\d+)\/(events|messages|fork|abort)$/);
	if (match) {
		const conversation = await getConversation(Number(match[1]));
		const action = match[2];
		if (method === "GET" && action === "events") return streamEvents(req, res, conversation);
		if (method === "POST" && action === "messages") {
			const body = await readBody(req);
			const content = String(body.text ?? "").trim();
			if (!content) throw new HttpError(400, "消息不能为空");
			if (content.length > 8000) throw new HttpError(413, "消息太长");
			const requestId = typeof body.requestId === "string" && body.requestId ? body.requestId.slice(0, 100) : undefined;
			const submission = await conversation.submit(
				{ type: "input", content, requestId, whenBusy: body.mode === "steer" ? "steer" : "followUp" },
				ctx,
			);
			await updateTitle(conversation.id, content.slice(0, 20));
			return sendJson(res, 202, { submissionId: submission.id });
		}
		if (method === "POST" && action === "fork") {
			const body = await readBody(req);
			const entryId = Number(body.entryId);
			if (!Number.isInteger(entryId)) throw new HttpError(400, "缺少 entryId");
			const index = await harness.snapshot(Index, ctx);
			const parent = index?.items.find((i) => i.id === conversation.id);
			const fork = await conversation.fork(
				entryId,
				{
					ownership: { kind: "ownerless" },
					init: registerIn({ title: `分叉：${parent?.title ?? conversation.id}`, forkOf: conversation.id, forkAtEntry: entryId }),
				},
				ctx,
			);
			return sendJson(res, 201, { id: fork.id });
		}
		if (method === "POST" && action === "abort") {
			await conversation.abort(ctx);
			return sendJson(res, 200, { ok: true });
		}
	}
	throw new HttpError(404, "接口不存在");
}

const server = createServer(async (req, res) => {
	if (!authorized(req)) {
		res.writeHead(401, { "www-authenticate": 'Basic realm="pi-durable-demo", charset="UTF-8"' });
		return res.end("需要口令");
	}
	try {
		await route(req, res);
	} catch (error) {
		const status = error instanceof HttpError ? error.status : 500;
		if (status === 500) console.error("请求出错：", redact(error?.stack || error));
		if (!res.headersSent) sendJson(res, status, { error: status === 500 ? "服务器出错，详情见服务器日志" : error.message });
		else res.end();
		exitIfFatal(error);
	}
});

server.listen(config.port, "0.0.0.0", () => {
	console.log(`pi-durable-demo 已启动：端口 ${config.port}，模型 ${modelLabel}，PID ${process.pid}`);
});
