import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CATEGORIES, type Memory } from "../types";
import {
	getMemoryById,
	insertMemory,
	queryMemoryChanges,
	queryMemoriesByTags,
	updateMemory,
} from "../utils/db";
import {
	buildDecisionRecord,
	classifyMemoryChanges,
	digestHasValidCitations,
	parseDecisionMemory,
	parseIsoTimestamp,
	projectTag,
	rankDigestSources,
	renderExtractiveDigest,
} from "../utils/daily-recall";
import { llmCallSystem } from "../utils/ai";
import { toolError, toolStructured } from "../utils/tool-result";
import { searchMemories, storeMemoryVector } from "../utils/vectorize";

export type DailyRecallDependencies = {
	now: () => Date;
	insertMemory: typeof insertMemory;
	updateMemory: typeof updateMemory;
	getMemoryById: typeof getMemoryById;
	queryMemoriesByTags: typeof queryMemoriesByTags;
	queryMemoryChanges: typeof queryMemoryChanges;
	searchMemories: typeof searchMemories;
	storeMemoryVector: typeof storeMemoryVector;
	callModel: typeof llmCallSystem;
};

const DEFAULT_DEPS: DailyRecallDependencies = {
	now: () => new Date(),
	insertMemory,
	updateMemory,
	getMemoryById,
	queryMemoriesByTags,
	queryMemoryChanges,
	searchMemories,
	storeMemoryVector,
	callModel: llmCallSystem,
};

export function createDailyRecallHandlers(
	userId: string,
	env: Env,
	deps: DailyRecallDependencies = DEFAULT_DEPS,
) {
	return {
		async rememberDecision(input: {
			decision: string;
			rationale?: string;
			project?: string;
			alternatives?: string[];
			decided_at?: string;
			tags?: string[];
		}) {
			try {
				const record = buildDecisionRecord(
					{
						decision: input.decision,
						rationale: input.rationale,
						project: input.project,
						alternatives: input.alternatives,
						decidedAt: input.decided_at,
						tags: input.tags,
					},
					deps.now().toISOString(),
				);
				const memory = await deps.insertMemory(
					{
						userId,
						text: record.text,
						subject: record.subject,
						tags: record.tags,
						category: "projects",
						layer: "long_embedded",
						source_type: "stated",
						confidence: 0.9,
						salience: 0.8,
					},
					env,
				);
				let embedding_status: "embedded" | "pending" = "pending";
				try {
					await deps.storeMemoryVector(memory.id, memory.text, userId, env, {
						category: memory.category,
						layer: memory.layer,
						salience: memory.salience,
					});
					await deps.updateMemory(memory.id, userId, { embedding_status: "embedded" }, env);
					embedding_status = "embedded";
				} catch {
					embedding_status = "pending";
				}
				const structuredContent = {
					id: memory.id,
					decision: input.decision.trim(),
					...(input.project?.trim() ? { project: input.project.trim() } : {}),
					decided_at: record.decidedAt,
					tags: record.tags,
					embedding_status,
				};
				return toolStructured(`Decision stored [${memory.id}]: ${input.decision.trim()}`, structuredContent);
			} catch (error) {
				return toolError(error);
			}
		},

		async recallDecisions(input: {
			query?: string;
			project?: string;
			start_date?: string;
			end_date?: string;
			limit: number;
		}) {
			try {
				const requiredTags = ["decision", ...(input.project ? [projectTag(input.project)] : [])];
				const tagged = await deps.queryMemoriesByTags(userId, requiredTags, env, 100);
				let byId = new Map<string, { memory: Memory; relevance?: number }>();
				for (const memory of tagged) {
					if (requiredTags.every((tag) => memory.tags.includes(tag))) byId.set(memory.id, { memory });
				}
				if (input.query?.trim()) {
					const hits = await deps.searchMemories(input.query, userId, env, 100);
					const hitScores = new Map(hits.map((hit) => [hit.id, hit.score]));
					byId = new Map(
						[...byId]
							.filter(([id]) => hitScores.has(id))
							.map(([id, value]) => [
								id,
								{ memory: value.memory, relevance: hitScores.get(id) },
							]),
					);
					for (const hit of hits) {
						if (byId.has(hit.id)) continue;
						const memory = await deps.getMemoryById(hit.id, userId, env);
						if (memory?.tags.includes("decision") && requiredTags.every((tag) => memory.tags.includes(tag))) {
							byId.set(memory.id, { memory, relevance: hit.score });
						}
					}
				}
				const start = input.start_date ? parseIsoTimestamp(input.start_date, "start_date") : undefined;
				const end = input.end_date ? parseIsoTimestamp(input.end_date, "end_date") : undefined;
				const decisions = [...byId.values()]
					.map(({ memory, relevance }) => parseDecisionMemory(memory, relevance))
					.filter((value): value is NonNullable<typeof value> => value !== null)
					.filter((value) => (!start || value.decided_at >= start) && (!end || value.decided_at <= end))
					.sort((a, b) => b.decided_at.localeCompare(a.decided_at) || (b.relevance ?? 0) - (a.relevance ?? 0))
					.slice(0, input.limit);
				const structuredContent = { count: decisions.length, decisions };
				const text = decisions.length
					? decisions.map((item) => `- [${item.id}] ${item.decided_at}: ${item.decision}`).join("\n")
					: "No matching decisions found.";
				return toolStructured(text, structuredContent);
			} catch (error) {
				return toolError(error);
			}
		},
	};
}

const decisionViewSchema = z.object({
	id: z.string(),
	decision: z.string(),
	project: z.string().optional(),
	decided_at: z.string(),
	rationale: z.string().optional(),
	alternatives: z.array(z.string()),
	relevance: z.number().optional(),
});

export function registerDailyRecallTools(server: McpServer, env: Env, userId: string) {
	const handlers = createDailyRecallHandlers(userId, env);

	server.registerTool(
		"remember_decision",
		{
			description: "Store a decision with its rationale, project, alternatives, and date as a consistently tagged ordinary memory.",
			inputSchema: z.object({
				decision: z.string().trim().min(1),
				rationale: z.string().trim().min(1).optional(),
				project: z.string().trim().min(1).optional(),
				alternatives: z.array(z.string().trim().min(1)).max(20).optional(),
				decided_at: z.string().optional(),
				tags: z.array(z.string().trim().min(1)).max(20).optional(),
			}),
			outputSchema: z.object({
				id: z.string(),
				decision: z.string(),
				project: z.string().optional(),
				decided_at: z.string(),
				tags: z.array(z.string()),
				embedding_status: z.enum(["embedded", "pending"]),
			}),
		},
		handlers.rememberDecision,
	);

	server.registerTool(
		"recall_decisions",
		{
			description: "Recall prior decisions by topic, project, or date range.",
			inputSchema: z
				.object({
					query: z.string().trim().min(1).optional(),
					project: z.string().trim().min(1).optional(),
					start_date: z.string().optional(),
					end_date: z.string().optional(),
					limit: z.number().int().min(1).max(50).default(10),
				})
				.superRefine((value, ctx) => {
					if (Boolean(value.start_date) !== Boolean(value.end_date)) {
						ctx.addIssue({
							code: z.ZodIssueCode.custom,
							message: "start_date and end_date must be supplied together",
						});
					}
				}),
			outputSchema: z.object({
				count: z.number().int().nonnegative(),
				decisions: z.array(decisionViewSchema),
			}),
		},
		handlers.recallDecisions,
	);
}
