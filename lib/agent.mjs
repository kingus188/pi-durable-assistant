// 模型接入、Documents、工具和 Harness 的组装
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createModels, createProvider, envApiKeyAuth, Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineDoc, defineExtension, defineTool, Harness, section } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

export const config = {
	port: Number(process.env.PORT || 3000),
	dataDir: process.env.DATA_DIR || "./data",
	password: process.env.DEMO_PASSWORD || "",
	api: process.env.LLM_API || "openai-completions",
	baseUrl: process.env.LLM_BASE_URL || "",
	model: process.env.LLM_MODEL || "",
	contextWindow: Number(process.env.LLM_CONTEXT_WINDOW || 128000),
	maxTokens: Number(process.env.LLM_MAX_TOKENS || 8192),
};

// 每个会话的记事本：Agent 自己维护的待办和备忘。fork 时继承分叉那一刻的内容。
export const Notes = defineDoc({
	kind: "app.notes",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ todos: [], memos: [] }),
});

// 会话列表：官方没有列出会话的接口，自己记一份
export const Index = defineDoc({
	kind: "app.index",
	version: 1,
	scope: "session",
	initial: () => ({ items: [] }),
});

// 进程信息：每次启动 boots + 1，用来在页面上证明进程重启过
export const Meta = defineDoc({
	kind: "app.meta",
	version: 1,
	scope: "session",
	initial: () => ({ boots: 0, lastBootAt: null }),
});

const API_LOADERS = {
	"openai-completions": async () => (await import("@earendil-works/pi-ai/api/openai-completions.lazy")).openAICompletionsApi(),
	"openai-responses": async () => (await import("@earendil-works/pi-ai/api/openai-responses.lazy")).openAIResponsesApi(),
	"anthropic-messages": async () => (await import("@earendil-works/pi-ai/api/anthropic-messages.lazy")).anthropicMessagesApi(),
};

async function createModelCatalog() {
	const models = createModels();
	if (config.api === "faux") {
		const faux = fauxProvider();
		faux.setResponses(Array(1000).fill(fauxScript));
		models.setProvider(faux.provider);
		return { models, agentModel: { provider: "faux", modelId: "faux-1" }, label: "faux（本地演示剧本）" };
	}
	const loadApi = API_LOADERS[config.api];
	if (!loadApi) throw new Error(`不支持的 LLM_API：${config.api}`);
	if (!config.baseUrl || !config.model) throw new Error("缺少 LLM_BASE_URL 或 LLM_MODEL");
	const model = {
		id: config.model,
		name: config.model,
		api: config.api,
		provider: "demo",
		baseUrl: config.baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: config.contextWindow,
		maxTokens: config.maxTokens,
		// 走未知中转，保守关闭可能不支持的字段
		...(config.api === "openai-completions" ? { compat: { supportsStore: false, supportsDeveloperRole: false } } : {}),
	};
	const provider = createProvider({
		id: "demo",
		name: "Demo",
		baseUrl: config.baseUrl,
		auth: { apiKey: envApiKeyAuth("Demo API key", ["LLM_API_KEY"]) },
		models: [model],
		api: await loadApi(),
	});
	models.setProvider(provider);
	return { models, agentModel: { provider: "demo", modelId: config.model }, label: config.model };
}

// faux 剧本：按最后一条用户消息之后助手已经回了几次，依次列待办、等待、勾完、回答
function fauxScript(context) {
	const messages = context.messages;
	const lastUser = messages.findLastIndex((m) => m.role === "user");
	const replies = messages.slice(lastUser + 1).filter((m) => m.role === "assistant").length;
	const steps = ["第一步：查资料", "第二步：等待 10 秒", "第三步：整理结论"];
	const toolUse = { stopReason: "toolUse" };
	if (replies === 0) return fauxAssistantMessage(steps.map((text) => fauxToolCall("todo", { action: "add", text })), toolUse);
	if (replies === 1) return fauxAssistantMessage([fauxToolCall("wait_seconds", { seconds: 10, reason: "演示长任务" })], toolUse);
	if (replies === 2) return fauxAssistantMessage(steps.map((text) => fauxToolCall("todo", { action: "done", text })), toolUse);
	return fauxAssistantMessage("演示任务完成。");
}

// 1.1.0 发布版的字段是 content（README 里的 output 是更新的写法）
const text = (value) => ({ content: [{ type: "text", text: value }] });

// 只允许访问公网地址，防止被用来探测服务器内网
function isPrivateAddress(address) {
	if (isIP(address) === 4) {
		const [a, b] = address.split(".").map(Number);
		return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
	}
	const v6 = address.toLowerCase();
	if (v6.startsWith("::ffff:")) return isPrivateAddress(v6.slice(7));
	return v6 === "::" || v6 === "::1" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe8") ||
		v6.startsWith("fe9") || v6.startsWith("fea") || v6.startsWith("feb");
}

async function assertPublicUrl(raw) {
	const url = new URL(raw);
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("只支持 http 和 https");
	const addresses = await lookup(url.hostname, { all: true });
	if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) throw new Error("不允许访问内网地址");
	return url;
}

function htmlToText(html) {
	return html
		.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
		.replace(/\s+/g, " ")
		.trim();
}

const fetchPage = defineTool({
	name: "fetch_page",
	description: "抓取一个公开网页的正文文字（最多 6000 字）",
	parameters: Type.Object({ url: Type.String({ description: "http 或 https 地址" }) }),
	replay: "safe",
	execute: async (args) => {
		let url = await assertPublicUrl(args.url);
		// 手动跟随跳转，每一跳都检查地址
		for (let hop = 0; hop < 5; hop++) {
			const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15_000), headers: { "user-agent": "pi-durable-demo" } });
			const location = response.headers.get("location");
			if (response.status >= 300 && response.status < 400 && location) {
				url = await assertPublicUrl(new URL(location, url).href);
				continue;
			}
			const body = htmlToText(await response.text()).slice(0, 6000);
			return text(`HTTP ${response.status}\n${body}`);
		}
		throw new Error("跳转次数过多");
	},
});

const waitSeconds = defineTool({
	name: "wait_seconds",
	description: "等待一段时间再继续（1 到 120 秒），用于定时、隔一会儿再检查之类的任务",
	parameters: Type.Object({ seconds: Type.Number(), reason: Type.Optional(Type.String()) }),
	replay: "safe",
	execute: async (args, api, callContext) => {
		const seconds = Math.min(120, Math.max(1, Math.round(args.seconds)));
		// 截止时间存进任务备忘：崩溃重启后按原截止时间接着等，而不是从头等
		const deadline = await api.memo("deadline", Date.now() + seconds * 1000, callContext);
		while (Date.now() < deadline) {
			api.output(`还剩 ${Math.ceil((deadline - Date.now()) / 1000)} 秒\n`);
			await new Promise((resolve) => setTimeout(resolve, Math.min(1000, deadline - Date.now())));
		}
		return text(`已等待 ${seconds} 秒`);
	},
});

const todo = defineTool({
	name: "todo",
	description: "维护待办：add 新增一条，done 把匹配的一条标记完成",
	parameters: Type.Object({ action: Type.Union([Type.Literal("add"), Type.Literal("done")]), text: Type.String() }),
	execute: async (args, api, callContext) => {
		const result = await api.commit(async (tx) => {
			const notes = await tx.doc(Notes, api.conversationId);
			if (args.action === "add") {
				notes.todos.push({ text: args.text, done: false });
				return `已添加：${args.text}`;
			}
			const item = notes.todos.find((t) => !t.done && t.text === args.text) ?? notes.todos.find((t) => !t.done && t.text.includes(args.text));
			if (!item) return `没找到待办：${args.text}`;
			item.done = true;
			return `已完成：${item.text}`;
		}, callContext);
		return text(result);
	},
});

const memo = defineTool({
	name: "memo",
	description: "记一条需要长期记住的备忘",
	parameters: Type.Object({ text: Type.String() }),
	execute: async (args, api, callContext) => {
		await api.commit(async (tx) => {
			(await tx.doc(Notes, api.conversationId)).memos.push(args.text);
		}, callContext);
		return text(`已记下：${args.text}`);
	},
});

const currentTime = defineTool({
	name: "current_time",
	description: "获取当前北京时间",
	parameters: Type.Object({}),
	replay: "safe",
	execute: async () => text(new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })),
});

const Assistant = defineExtension({
	name: "assistant",
	tools: [fetchPage, waitSeconds, todo, memo, currentTime],
	sections: [
		section(
			"preamble",
			() =>
				[
					"你是“小墨的 Durable 助手”，用简体中文简洁回答。",
					"遇到多步骤任务，先用 todo 列出步骤，做完一步标记一步。",
					"用户要求等待、定时、隔一段时间再检查时，用 wait_seconds。",
					"需要长期记住的信息用 memo。查网页用 fetch_page。",
				].join("\n"),
			{ tag: false },
		),
		section("notes", async (input, renderContext) => {
			const notes = await input.read.snapshot(Notes, input.conversationId, renderContext);
			if (!notes || (notes.todos.length === 0 && notes.memos.length === 0)) return undefined;
			const todos = notes.todos.map((t) => `${t.done ? "[x]" : "[ ]"} ${t.text}`);
			const memos = notes.memos.map((m) => `- ${m}`);
			return ["当前记事本：", ...todos, ...memos].join("\n");
		}),
	],
});

export async function openAgent(context) {
	await mkdir(config.dataDir, { recursive: true });
	const { models, agentModel, label } = await createModelCatalog();
	const registry = createRegistry();
	registry.install(Assistant);
	const storage = await openNodeSqliteStorage(join(config.dataDir, "agent.sqlite"));
	// 1.1.0 发布版还没有 README 里的 harness.closed，非致命错误从 onReport 打日志
	const harness = await Harness.open(storage, { models, registry, onReport: (error) => console.error("Harness 报告：", error) }, context);
	// 根会话只用来写会话库级 Document，不出现在列表里
	const root = await harness.root(context, { agent: { model: agentModel } });
	await root.commit(async (tx) => {
		const meta = await tx.doc(Meta);
		meta.boots += 1;
		meta.lastBootAt = new Date().toISOString();
	}, context);
	// 继续上个进程没做完的任务
	harness.resume();
	return { harness, root, agentModel, modelLabel: label };
}
