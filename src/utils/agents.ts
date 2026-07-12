/**
 * Multi-agent orchestration helpers: gather memory context, run role-specific
 * Workers AI prompts, and log runs for auditability.
 */

import { llmCallSystem } from "./ai";
import {
	fulltextSearchMemories,
	getHighSalienceMemories,
	getPinnedMemories,
	insertAgentRun,
	queryMemories,
	touchMemoryAccessBatch,
} from "./db";
import { getLivingSummary } from "./kv";
import { readStaticFile } from "./static-context";
import { rerankMatches, searchMemories } from "./vectorize";

export type AgentContextPack = {
	summary: string | null;
	selfProfile: string | null;
	contextCurrent: string | null;
	pinned: Array<{ id: string; text: string; category: string }>;
	related: Array<{ id: string; text: string; score: number }>;
	highSalience: Array<{ id: string; text: string; salience: number }>;
	memoryIds: string[];
};

/** Avoid circular import issues if getLivingSummarySafe isn't on db — use KV directly. */
async function livingSummary(userId: string, env: Env): Promise<string | null> {
	try {
		return await getLivingSummary(userId, env);
	} catch {
		return null;
	}
}

export async function buildAgentContext(
	userId: string,
	query: string,
	env: Env,
	opts?: { relatedLimit?: number },
): Promise<AgentContextPack> {
	const relatedLimit = opts?.relatedLimit ?? 12;
	const [summary, selfProfile, contextCurrent, pinned, highSalience] = await Promise.all([
		livingSummary(userId, env),
		readStaticFile(userId, "self_profile", env),
		readStaticFile(userId, "context_current", env),
		getPinnedMemories(userId, env, 12),
		getHighSalienceMemories(userId, env, 0.75, 10),
	]);

	let related: Array<{ id: string; text: string; score: number }> = [];
	try {
		const vectorHits = await searchMemories(query, userId, env, relatedLimit * 2);
		const boosts = new Map<
			string,
			{ salience?: number; confidence?: number; pinned?: boolean; access_count?: number }
		>();
		for (const p of pinned) {
			boosts.set(p.id, {
				salience: p.salience,
				confidence: p.confidence,
				pinned: true,
				access_count: p.access_count,
			});
		}
		const ranked = rerankMatches(
			query,
			vectorHits.map((h) => ({
				id: h.id,
				content: h.content,
				score: h.score,
			})),
			boosts,
		).slice(0, relatedLimit);
		related = ranked.map((r) => ({ id: r.id, text: r.content, score: r.score }));
	} catch {
		const kw = await fulltextSearchMemories(userId, query, env, relatedLimit);
		related = kw.map((m, i) => ({ id: m.id, text: m.text, score: 0.5 - i * 0.01 }));
	}

	if (related.length === 0) {
		const recent = await queryMemories(userId, env, { suppressed: false, limit: 8 });
		related = recent.map((m) => ({ id: m.id, text: m.text, score: 0.4 }));
	}

	const memoryIds = [
		...new Set([
			...pinned.map((p) => p.id),
			...related.map((r) => r.id),
			...highSalience.map((h) => h.id),
		]),
	];
	await touchMemoryAccessBatch(memoryIds.slice(0, 25), userId, env);

	return {
		summary,
		selfProfile,
		contextCurrent,
		pinned: pinned.map((p) => ({ id: p.id, text: p.text, category: p.category })),
		related,
		highSalience: highSalience.map((h) => ({
			id: h.id,
			text: h.text,
			salience: h.salience,
		})),
		memoryIds,
	};
}

function formatContext(ctx: AgentContextPack): string {
	const parts: string[] = [];
	if (ctx.summary) parts.push(`## Living summary\n${ctx.summary}`);
	if (ctx.selfProfile) parts.push(`## Self profile\n${ctx.selfProfile.slice(0, 2000)}`);
	if (ctx.contextCurrent) parts.push(`## Current context\n${ctx.contextCurrent}`);
	if (ctx.pinned.length) {
		parts.push(
			`## Pinned memories\n${ctx.pinned.map((p) => `- [${p.category}] ${p.text}`).join("\n")}`,
		);
	}
	if (ctx.highSalience.length) {
		parts.push(
			`## High-salience memories\n${ctx.highSalience.map((h) => `- (sal ${h.salience.toFixed(2)}) ${h.text}`).join("\n")}`,
		);
	}
	if (ctx.related.length) {
		parts.push(
			`## Related memories\n${ctx.related.map((r) => `- (${r.score.toFixed(3)}) ${r.text}`).join("\n")}`,
		);
	}
	return parts.join("\n\n") || "(No memory context available.)";
}

const ROLE_SYSTEM: Record<string, string> = {
	memory:
		"You are a personal memory specialist. Answer ONLY from the provided memory context. Cite which memories support each claim. If the context is insufficient, say what is missing. Be concise and factual. Australian English.",
	research:
		"You are a research agent over a personal knowledge base. Synthesize what is known about the topic from memory, note gaps, and suggest what to FOI, verify, or store next. Separate proven vs inferred. Australian English.",
	drafting:
		"You are a drafting agent for Jamie Young. Produce paste-ready text in Australian English: direct declarative prose, no AI-slop, formal when legal/administrative, dry economy otherwise. Prefer evidence-grounded claims. Do not invent facts not in context.",
	evidence:
		"You are an evidence and chronology agent for legal-administrative work. Structure: timeline, admitted facts, exhibits→propositions, gaps, procedural fairness issues, opposing-party counters. Never overstate legal conclusions. Australian English.",
	strategy:
		"You are a strategy agent. Identify the real issue beneath surface wording, incentives, omissions, likely next moves, and multi-pathway options. Separate private blunt analysis from what a controlled public draft should say. Australian English.",
	style:
		"You are a style auditor for Jamie Young. Check the draft against preferences: Australian English, direct declarative prose, no hedging fluff, evidence-grounded, adult-to-adult, paste-ready. List concrete edits. Australian English.",
	morning:
		"You are the morning memory coach. Propose 1-3 high-value things to teach or update in long-term memory based on context and gaps. Prefer durable facts, rules, and project status over trivia. Australian English.",
	general:
		"You are a capable personal AI agent with access to the user's long-term memory. Be precise, useful, and explicit about uncertainty. Australian English.",
};

export async function runRoleAgent(
	role: string,
	userId: string,
	input: string,
	env: Env,
	extraInstruction?: string,
): Promise<{ output: string; runId: string; memoryIds: string[]; contextUsed: number }> {
	const ctx = await buildAgentContext(userId, input, env);
	const system =
		(ROLE_SYSTEM[role] ?? ROLE_SYSTEM.general) +
		(extraInstruction ? `\n\nAdditional instruction: ${extraInstruction}` : "");
	const userPrompt = `${formatContext(ctx)}\n\n---\n\n## Task\n${input}`;
	const output = await llmCallSystem(system, userPrompt, env, 1800);
	const runId = await insertAgentRun(userId, role, input, output, ctx.memoryIds, env);
	return {
		output,
		runId,
		memoryIds: ctx.memoryIds,
		contextUsed: ctx.memoryIds.length,
	};
}

export async function multiAgentDebate(
	userId: string,
	question: string,
	env: Env,
): Promise<string> {
	const ctx = await buildAgentContext(userId, question, env);
	const pack = formatContext(ctx);
	const advocate = await llmCallSystem(
		"You argue FOR the strongest evidence-based position using only the memory context. Be rigorous.",
		`${pack}\n\nQuestion: ${question}\n\nWrite the FOR case.`,
		env,
		900,
	);
	const skeptic = await llmCallSystem(
		"You stress-test the position. Find gaps, benign alternatives, and what an opposing party would say. Use only the memory context.",
		`${pack}\n\nQuestion: ${question}\n\nAdvocate said:\n${advocate}\n\nWrite the stress-test / AGAINST case.`,
		env,
		900,
	);
	const synthesis = await llmCallSystem(
		"You are a neutral adjudicator. Synthesize both sides into a balanced conclusion with residual uncertainties.",
		`Question: ${question}\n\nFOR:\n${advocate}\n\nSTRESS-TEST:\n${skeptic}\n\nWrite a balanced synthesis.`,
		env,
		900,
	);
	await insertAgentRun(
		userId,
		"debate",
		question,
		synthesis,
		ctx.memoryIds,
		env,
	);
	return `# Multi-agent debate\n\n## For\n${advocate}\n\n## Stress-test\n${skeptic}\n\n## Synthesis\n${synthesis}`;
}
