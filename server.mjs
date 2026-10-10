// HTTP 服务：静态页面、JSON 接口和 SSE 推送
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { config, Index, Meta, Notes, openAgent } from "./lib/agent.mjs";

const { harness, root, agentModel, modelLabel } = await openAgent(ctx);
const startedAt = new Date().toISOString();

const indexHtml = new URL("./public/index.html", import.meta.url);

class HttpError extends Error {
	constructor(status, message) {
		super(message);
		this.status = status;
	}
}

function sendJson(res, status, body) {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	res.end(JSON.stringify(body));
}

async function readBody(req) {
	let raw = "";
	for await (const chunk of req) {
		raw += chunk;
		if (raw.length > 100_000) throw new HttpError(413, "请求太大");
	}
	if (!raw) return {};
	try {
		return JSON.parse(raw);
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

async function getConversation(id) {
	const conversation = Number.isInteger(id) && id !== root.id ? await harness.conversation(id, ctx) : undefined;
	if (!conversation) throw new HttpError(404, "会话不存在");
	return conversation;
}

async function addToIndex(item) {
	await root.commit(async (tx) => {
		(await tx.doc(Index)).items.push(item);
	}, ctx);
}

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
				error: message.stopReason === "error" ? message.errorMessage || "模型调用失败" : undefined,
			});
		} else if (entry.kind === "pi.tool-result") {
			entries.push({
				id: entry.id,
				kind: "tool",
				toolCallId: message.toolCallId,
				name: message.toolName,
				text: contentText(message.content),
				isError: Boolean(message.isError),
			});
		}
	}
	const live = value.docs?.["pi.live"] ?? {};
	return {
		conversationId,
		entries,
		live,
		busy: Object.keys(live).length > 0,
		inbox: value.docs?.["pi.inbox"]?.items?.length ?? 0,
		notes: (await harness.snapshot(Notes, conversationId, ctx)) ?? { todos: [], memos: [] },
		usage: value.docs?.["pi.usage"] ?? null,
	};
}

async function streamEvents(req, res, conversation) {
	res.writeHead(200, {
		"content-type": "text/event-stream; charset=utf-8",
		"cache-control": "no-store",
		connection: "keep-alive",
		"x-accel-buffering": "no",
	});
	const view = await conversation.viewState(ctx);
	let timer = null;
	let closed = false;
	const push = async () => {
		timer = null;
		if (closed) return;
		try {
			res.write(`event: view\ndata: ${JSON.stringify(await simplifyView(conversation.id, view.value))}\n\n`);
		} catch (error) {
			console.error("推送失败：", error.message);
		}
	};
	// 合并推送，最多每 150ms 一次
	const schedule = () => {
		if (!timer) timer = setTimeout(push, 150);
	};
	await push();
	const unsubscribe = view.subscribe(schedule);
	const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
	req.on("close", () => {
		closed = true;
		clearInterval(ping);
		clearTimeout(timer);
		unsubscribe();
		view.dispose();
	});
}

async function route(req, res) {
	const url = new URL(req.url, "http://localhost");
	const path = url.pathname;
	const method = req.method;

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
			const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: agentModel } }, ctx);
			await addToIndex({ id: conversation.id, title: "新对话", createdAt: new Date().toISOString() });
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
			const requestId = typeof body.requestId === "string" && body.requestId ? body.requestId : undefined;
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
			const fork = await conversation.fork(entryId, { ownership: { kind: "ownerless" } }, ctx);
			const index = await harness.snapshot(Index, ctx);
			const parent = index?.items.find((i) => i.id === conversation.id);
			await addToIndex({
				id: fork.id,
				title: `分叉：${parent?.title ?? conversation.id}`,
				createdAt: new Date().toISOString(),
				forkOf: conversation.id,
				forkAtEntry: entryId,
			});
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
		if (status === 500) console.error(error);
		if (!res.headersSent) sendJson(res, status, { error: status === 500 ? `服务器出错：${error.message}` : error.message });
		else res.end();
	}
});

server.listen(config.port, "0.0.0.0", () => {
	console.log(`pi-durable-demo 已启动：端口 ${config.port}，模型 ${modelLabel}，PID ${process.pid}`);
});
