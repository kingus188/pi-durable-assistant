// 跨会话记忆和技能。模型只能提交候选，用户批准后才进入提示。
import { randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { defineDoc, defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { normalizeRequestId } from "./v3-utils.mjs";
import { knowledgeStatus, readKnowledge, searchKnowledge } from "./knowledge.mjs";

const detach = (value) => JSON.parse(JSON.stringify(value));
const resultText = (value) => ({ content: [{ type: "text", text: value }] });

const MEMORY_ITEM_MAX = 280;
const MEMORY_APPROVED_MAX = 30;
const MEMORY_PENDING_MAX = 40;
const MEMORY_PROMPT_CHARS = 1800;
const SKILL_NAME_MAX = 40;
const SKILL_DESC_MAX = 180;
const SKILL_BODY_MAX = 4000;
const SKILL_APPROVED_MAX = 20;
const SKILL_PENDING_MAX = 20;

export const MemoryDoc = defineDoc({
	kind: "app.memory",
	version: 1,
	scope: "session",
	initial: () => ({ items: [], applied: {} }),
});

export const SkillsDoc = defineDoc({
	kind: "app.skills",
	version: 1,
	scope: "session",
	initial: () => ({ items: [], applied: {} }),
});

export function normalizeMemoryText(value) {
	const text = String(value ?? "").replace(/\s+/g, " ").trim();
	if (!text || text.length > MEMORY_ITEM_MAX) throw new Error(`记忆必须是 1～${MEMORY_ITEM_MAX} 字`);
	return text;
}

export function normalizeSkill(input) {
	const name = String(input?.name ?? "").trim();
	const description = String(input?.description ?? "").trim();
	const body = String(input?.body ?? "").trim();
	if (!name || name.length > SKILL_NAME_MAX || /[/\n\r]/.test(name)) throw new Error(`技能名称必须是 1～${SKILL_NAME_MAX} 字，且不能包含斜杠`);
	if (!description || description.length > SKILL_DESC_MAX) throw new Error(`技能说明必须是 1～${SKILL_DESC_MAX} 字`);
	if (!body || body.length > SKILL_BODY_MAX) throw new Error(`技能正文必须是 1～${SKILL_BODY_MAX} 字`);
	return { name, description, body };
}

export function selectMemoryForPrompt(items, budget = MEMORY_PROMPT_CHARS) {
	const approved = (items ?? []).filter((item) => item.status === "approved");
	const chosen = [];
	let used = 0;
	for (const item of [...approved].reverse()) {
		if (used + item.text.length > budget) continue;
		chosen.push(item);
		used += item.text.length;
	}
	return chosen.reverse();
}

function count(doc, status) {
	return doc.items.filter((item) => item.status === status).length;
}

function findApplied(doc, requestId) {
	if (!requestId || !Object.hasOwn(doc.applied, requestId)) return null;
	return doc.items.find((item) => item.id === doc.applied[requestId]) ?? null;
}

export async function proposeMemoryInTx(tx, input) {
	const requestId = normalizeRequestId(input.requestId);
	const doc = await tx.doc(MemoryDoc);
	const previous = findApplied(doc, requestId);
	if (previous) return detach(previous);
	const text = normalizeMemoryText(input.text);
	const status = input.approved ? "approved" : "pending";
	if (status === "pending" && count(doc, "pending") >= MEMORY_PENDING_MAX) throw new Error("待确认记忆已满，请先处理");
	if (status === "approved" && count(doc, "approved") >= MEMORY_APPROVED_MAX) throw new Error("已确认记忆已满，请先撤回一些");
	const now = Date.now();
	const item = {
		id: randomUUID(),
		text,
		status,
		source: input.source === "user" ? "user" : "agent",
		conversationId: input.conversationId ?? null,
		createdAt: now,
		decidedAt: status === "approved" ? now : null,
	};
	doc.items.push(item);
	if (requestId) doc.applied[requestId] = item.id;
	return detach(item);
}

export async function decideMemoryInTx(tx, id, action) {
	const doc = await tx.doc(MemoryDoc);
	const item = doc.items.find((entry) => entry.id === id);
	if (!item) throw new Error("记忆不存在");
	const next = action === "approve" ? "approved" : "rejected";
	if (item.status === next) return detach(item);
	if (next === "approved" && item.status !== "approved" && count(doc, "approved") >= MEMORY_APPROVED_MAX) {
		throw new Error("已确认记忆已满，请先撤回一些");
	}
	item.status = next;
	item.decidedAt = Date.now();
	return detach(item);
}

export async function proposeSkillInTx(tx, input) {
	const requestId = normalizeRequestId(input.requestId);
	const doc = await tx.doc(SkillsDoc);
	const previous = findApplied(doc, requestId);
	if (previous) return detach(previous);
	const skill = normalizeSkill(input);
	if (doc.items.some((item) => item.name === skill.name && item.status !== "rejected")) {
		throw new Error("已有同名技能");
	}
	const status = input.approved ? "approved" : "pending";
	if (status === "pending" && count(doc, "pending") >= SKILL_PENDING_MAX) throw new Error("待确认技能已满，请先处理");
	if (status === "approved" && count(doc, "approved") >= SKILL_APPROVED_MAX) throw new Error("已确认技能已满，请先撤回一些");
	const now = Date.now();
	const item = {
		id: randomUUID(),
		...skill,
		status,
		source: input.source === "user" ? "user" : "agent",
		conversationId: input.conversationId ?? null,
		createdAt: now,
		decidedAt: status === "approved" ? now : null,
	};
	doc.items.push(item);
	if (requestId) doc.applied[requestId] = item.id;
	return detach(item);
}

export async function decideSkillInTx(tx, id, action) {
	const doc = await tx.doc(SkillsDoc);
	const item = doc.items.find((entry) => entry.id === id);
	if (!item) throw new Error("技能不存在");
	const next = action === "approve" ? "approved" : "rejected";
	if (item.status === next) return detach(item);
	if (next === "approved") {
		if (doc.items.some((entry) => entry.id !== item.id && entry.name === item.name && entry.status === "approved")) {
			throw new Error("已有同名技能");
		}
		if (count(doc, "approved") >= SKILL_APPROVED_MAX) throw new Error("已确认技能已满，请先撤回一些");
	}
	item.status = next;
	item.decidedAt = Date.now();
	return detach(item);
}

export function publicMemory(doc) {
	return (doc?.items ?? []).map(({ id, text, status, source, createdAt, decidedAt }) => ({ id, text, status, source, createdAt, decidedAt }));
}

export function publicSkills(doc) {
	return (doc?.items ?? []).map(({ id, name, description, body, status, source, createdAt, decidedAt }) => ({
		id, name, description, body, status, source, createdAt, decidedAt,
	}));
}

function formatHit(hit) {
	const range = hit.line === hit.endLine ? String(hit.line) : `${hit.line}-${hit.endLine}`;
	return [`- ${hit.path}:${range} [${hit.status}] ${hit.revision}`, hit.excerpt].join("\n");
}

export const Personal = defineExtension({
	name: "personal-memory",
	tools: [
		defineTool({
			name: "propose_memory",
			replay: "safe",
			description: "提交一条跨会话长期记忆候选。不会立即生效，必须等用户在任务中心批准。只提交稳定事实或偏好，不要提交整段聊天。",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (args, api, context) => {
				const item = await api.commit((tx) => proposeMemoryInTx(tx, {
					text: args.text,
					requestId: "tool:" + api.callId,
					conversationId: api.conversationId,
					source: "agent",
					approved: false,
				}), context);
				const state = item.status === "approved" ? "已在记忆中" : "已提交，等待用户批准，尚未生效";
				return resultText(`${state}：${item.text}`);
			},
		}),
		defineTool({
			name: "read_skill",
			replay: "safe",
			description: "按名称读取一条已批准技能的全文。未批准的技能不能当步骤使用。",
			parameters: Type.Object({ name: Type.String() }),
			execute: async (args, api, context) => {
				const name = String(args.name ?? "").trim();
				const items = await api.commit(async (tx) => detach((await tx.doc(SkillsDoc)).items), context);
				const item = items.find((entry) => entry.name === name && entry.status === "approved");
				if (!item) return resultText(`没有已批准的技能：${name}`);
				return resultText(`技能 ${item.name}\n${item.description}\n\n${item.body}`);
			},
		}),
		defineTool({
			name: "propose_skill",
			replay: "safe",
			description: "把一套可复用步骤提交为技能候选。批准前不要把它写成已经可用。",
			parameters: Type.Object({
				name: Type.String(),
				description: Type.String({ description: "什么情况下该读取这条技能" }),
				body: Type.String({ description: "步骤、约束和如何确认做完" }),
			}),
			execute: async (args, api, context) => {
				const item = await api.commit((tx) => proposeSkillInTx(tx, {
					...args,
					requestId: "tool:" + api.callId,
					conversationId: api.conversationId,
					source: "agent",
					approved: false,
				}), context);
				return resultText(`技能「${item.name}」${item.status === "approved" ? "已可用" : "已提交，等待批准"}`);
			},
		}),
		defineTool({
			name: "search_knowledge",
			replay: "safe",
			description: "在允许的 Obsidian 目录里检索笔记，返回路径、行号和修订标识。默认不把归档当现行。问以前的内容时把 includeHistorical 设为 true。",
			parameters: Type.Object({
				query: Type.String(),
				includeHistorical: Type.Optional(Type.Boolean()),
			}),
			execute: async (args) => {
				try {
					const found = await searchKnowledge(args.query, { includeHistorical: args.includeHistorical === true });
					if (found.hits.length === 0) return resultText(`知识库里没有找到「${found.query}」。不要把没找到说成没有发生过。`);
					return resultText(["检索到这些来源，回答时请附上路径和行号：", ...found.hits.map(formatHit)].join("\n"));
				} catch (error) {
					return resultText(`无法检索知识库：${error.message}`);
				}
			},
		}),
		defineTool({
			name: "read_knowledge",
			replay: "safe",
			description: "按相对路径阅读一篇允许范围内的笔记，从指定行开始。归档笔记的结论不能当作现行决定。",
			parameters: Type.Object({
				path: Type.String(),
				line: Type.Optional(Type.Number()),
			}),
			execute: async (args) => {
				try {
					const page = await readKnowledge(args.path, args.line ?? 1);
					const warning = page.status === "archived" ? "这是归档或历史快照，不能当作现行决定。\n" : page.status === "draft" ? "这是草稿，不是已确认事实。\n" : "";
					return resultText(`${warning}${page.path}:${page.startLine}-${page.endLine} [${page.status}] ${page.revision}${page.truncated ? "（已截断）" : ""}\n${page.text}`);
				} catch (error) {
					return resultText(`无法阅读笔记：${error.message}`);
				}
			},
		}),
	],
	sections: [
		section("memory", async (input, renderContext) => {
			const doc = await input.read.snapshot(MemoryDoc, renderContext);
			const items = selectMemoryForPrompt(doc?.items);
			if (items.length === 0) return undefined;
			return ["已确认的长期记忆（未出现在这里的内容都还没批准）：", ...items.map((item) => `- ${item.text}`)].join("\n");
		}),
		section("skills", async (input, renderContext) => {
			const doc = await input.read.snapshot(SkillsDoc, renderContext);
			const items = (doc?.items ?? []).filter((item) => item.status === "approved");
			if (items.length === 0) return undefined;
			return ["已批准技能。先用 read_skill 读取全文，不要凭名称编造步骤：", ...items.map((item) => `- ${item.name}：${item.description}`)].join("\n");
		}),
	],
});

export function personalError(error) {
	return /记忆|技能|requestId|路径|笔记|知识库|OBSIDIAN|符号链接|阅读|检索|跳出/.test(error?.message || "");
}

export { knowledgeStatus };
