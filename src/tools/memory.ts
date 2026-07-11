import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CATEGORIES, LAYERS, type Memory, SOURCE_TYPES } from "../types";
import { analyzePatterns, detectContradictions, generateSummary, triageText } from "../utils/ai";
import {
	deleteMemory,
	fulltextSearchMemories,
	getHighSalienceMemories,
	getMemoriesNeedingReverification,
	getMemoryById,
	getMemoryIndex,
	getPinnedMemories,
	getSuppressedMemories,
	getUnembeddedMemories,
	insertMemory,
	memoryExistsByText,
	queryMemories,
	queryMemoriesByDate,
	queryMemoriesByTags,
	touchMemoryAccessBatch,
	updateMemory,
} from "../utils/db";
import { putLivingSummary } from "../utils/kv";
import { toolError, toolText } from "../utils/tool-result";
import {
	deleteVectorById,
	rerankMatches,
	searchMemories,
	storeMemoryVector,
} from "../utils/vectorize";

async function embedMemory(
	memory: { id: string; text: string; category?: string; layer?: string; salience?: number; pinned?: boolean },
	userId: string,
	env: Env,
): Promise<void> {
	await storeMemoryVector(memory.id, memory.text, userId, env, {
		category: memory.category ?? "knowledge",
		layer: memory.layer ?? "current",
		salience: memory.salience ?? 0.5,
		pinned: memory.pinned ? 1 : 0,
	});
	await updateMemory(memory.id, userId, { embedding_status: "embedded" } as any, env);
}

export function registerMemoryTools(server: McpServer, env: Env, userId: string) {
	server.tool(
		"write_memory",
		"Store a new long-term memory about the user. Use this whenever the user shares a fact, preference, opinion, or experience worth remembering across sessions. Automatically checks for contradictions against existing memories and generates a vector embedding for semantic search. If the new memory contradicts an older one, the old memory is suppressed with an audit trail.",
		{
			text: z
				.string()
				.describe(
					"The memory content — a complete, self-contained statement (e.g., 'User prefers dark mode in all code editors')",
				),
			category: z
				.enum(CATEGORIES)
				.optional()
				.describe(
					"Memory category: identity, relationship, projects, cybersec, finance, ai, health, rules, creative, preferences, likes, goals, knowledge, corrections",
				),
			layer: z
				.enum(LAYERS)
				.optional()
				.describe(
					"Durability tier: core (permanent facts), long_embedded (established patterns), mid_ground (moderate confidence), current (recent/provisional)",
				),
			subject: z.string().optional().describe("Brief title, max 10 words"),
			tags: z
				.array(z.string())
				.optional()
				.describe("1-5 keyword tags for search (e.g., ['python', 'coding', 'preference'])"),
			triggers: z
				.array(z.string())
				.optional()
				.describe("Keywords that should surface this memory in future queries"),
			confidence: z
				.number()
				.min(0)
				.max(1)
				.optional()
				.describe("How confident this information is accurate (0-1, default 0.8)"),
			salience: z
				.number()
				.min(0)
				.max(1)
				.optional()
				.describe("How important/relevant this is (0-1, default 0.5)"),
			emotion_weight: z
				.number()
				.min(0)
				.max(1)
				.optional()
				.describe("Emotional significance (0=neutral, 1=highly emotional)"),
			source_type: z
				.enum(SOURCE_TYPES)
				.optional()
				.describe(
					"How this was learned: stated (user said it), observed (behavior), inferred (deduced)",
				),
			linked_people: z
				.array(z.string())
				.optional()
				.describe("Person IDs this memory relates to"),
		},
		async (params) => {
			try {
				let contradictions: Array<{
					existing_id: string;
					explanation: string;
					contradiction_type: string;
				}> = [];
				try {
					const existing = await searchMemories(params.text, userId, env, 5);
					contradictions = await detectContradictions(
						params.text,
						existing.map((m) => ({ id: m.id, text: m.content, score: m.score })),
						env,
					);

					for (const c of contradictions) {
						if (c.contradiction_type === "direct") {
							await updateMemory(
								c.existing_id,
								userId,
								{
									suppressed: true,
									suppression_reason: `Contradicted by newer memory: ${c.explanation}`,
								} as any,
								env,
							);
						}
					}
				} catch (e) {
					console.error("Contradiction check skipped:", e);
				}

				const memory = await insertMemory({ userId, ...params }, env);

				let embeddingWarning = "";
				try {
					await embedMemory(memory, userId, env);
				} catch (e) {
					console.error("Embedding failed:", e);
					embeddingWarning =
						"\n\nWarning: memory stored, but its embedding remains pending for backfill.";
				}

				let response = `Memory stored [${memory.id}]: ${params.text}`;
				if (contradictions.length > 0) {
					response += `\n\nContradictions detected and handled:\n${contradictions
						.map((c) => `- ${c.explanation} (${c.contradiction_type})`)
						.join("\n")}`;
				}
				response += embeddingWarning;

				return toolText(response);
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.tool(
		"edit_memory",
		"Update an existing memory's content or metadata. Use this to correct, refine, or reclassify a memory. If the text is changed, the vector embedding is automatically regenerated.",
		{
			id: z.string().describe("Memory ID to edit"),
			text: z.string().optional().describe("New memory content (triggers re-embedding)"),
			category: z.enum(CATEGORIES).optional(),
			layer: z.enum(LAYERS).optional(),
			subject: z.string().optional(),
			tags: z.array(z.string()).optional(),
			triggers: z.array(z.string()).optional(),
			confidence: z.number().min(0).max(1).optional(),
			salience: z.number().min(0).max(1).optional(),
			emotion_weight: z.number().min(0).max(1).optional(),
			source_type: z.enum(SOURCE_TYPES).optional(),
			linked_people: z.array(z.string()).optional(),
		},
		async (params) => {
			try {
				const { id, ...updates } = params;
				if (updates.text) {
					await updateMemory(
						id,
						userId,
						{ ...updates, embedding_status: "pending" } as any,
						env,
					);
					try {
						const updated = await getMemoryById(id, userId, env);
						if (updated) await embedMemory(updated, userId, env);
						else await embedMemory({ id, text: updates.text }, userId, env);
					} catch (error) {
						return toolError(
							new Error(
								`Memory ${id} updated, but embedding failed and remains pending: ${String(
									error,
								)}`,
							),
						);
					}
				} else {
					await updateMemory(id, userId, updates as any, env);
				}
				return toolText(`Memory ${id} updated.`);
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.tool(
		"forget_memory",
		"Permanently delete a memory from both the database and vector index. This is irreversible. For soft-deletion, use suppress_memory instead.",
		{
			id: z.string().describe("Memory ID to permanently delete"),
			reason: z
				.string()
				.optional()
				.describe("Why this memory is being forgotten (for audit purposes)"),
		},
		async ({ id, reason }) => {
			try {
				await deleteMemory(id, userId, env);
				try {
					await deleteVectorById(id, env);
				} catch {
					/* best effort */
				}
				return toolText(`Memory ${id} forgotten.${reason ? ` Reason: ${reason}` : ""}`);
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.tool(
		"suppress_memory",
		"Soft-delete a memory by marking it as suppressed. The memory remains in the database with an audit trail but is excluded from queries and search results. Use restore_memory to undo.",
		{
			id: z.string().describe("Memory ID to suppress"),
			reason: z.string().describe("Why this memory is being suppressed"),
		},
		async ({ id, reason }) => {
			try {
				const memory = await getMemoryById(id, userId, env);
				if (!memory)
					return { content: [{ type: "text", text: `Memory ${id} not found.` }] };
				await updateMemory(
					id,
					userId,
					{ suppressed: true, suppression_reason: reason } as any,
					env,
				);
				return { content: [{ type: "text", text: `Memory ${id} suppressed: ${reason}` }] };
			} catch (error) {
				return {
					content: [
						{ type: "text", text: "Failed to suppress memory: " + String(error) },
					],
				};
			}
		},
	);

	server.tool(
		"restore_memory",
		"Restore a previously suppressed memory, making it active again in queries and search results.",
		{
			id: z.string().describe("Memory ID to restore"),
		},
		async ({ id }) => {
			try {
				const memory = await getMemoryById(id, userId, env);
				if (!memory)
					return { content: [{ type: "text", text: `Memory ${id} not found.` }] };
				if (!memory.suppressed)
					return { content: [{ type: "text", text: `Memory ${id} is not suppressed.` }] };
				await updateMemory(
					id,
					userId,
					{ suppressed: false, suppression_reason: null } as any,
					env,
				);
				return {
					content: [
						{
							type: "text",
							text: `Memory ${id} restored (was suppressed: ${memory.suppression_reason}).`,
						},
					],
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: "Failed to restore memory: " + String(error) }],
				};
			}
		},
	);

	server.tool(
		"verify_memory",
		"Mark a memory as verified/confirmed, resetting its confidence to a high value and updating last_verified timestamp. Use this when the user reconfirms a fact that may have decayed in confidence.",
		{
			id: z.string().describe("Memory ID to verify"),
			confidence: z
				.number()
				.min(0)
				.max(1)
				.optional()
				.default(0.95)
				.describe("Confidence to set (default 0.95)"),
		},
		async ({ id, confidence }) => {
			try {
				const memory = await getMemoryById(id, userId, env);
				if (!memory)
					return { content: [{ type: "text", text: `Memory ${id} not found.` }] };
				await updateMemory(
					id,
					userId,
					{
						confidence,
						last_verified: new Date().toISOString(),
					} as any,
					env,
				);
				return {
					content: [
						{
							type: "text",
							text: `Memory ${id} verified — confidence set to ${confidence}, timestamp updated.`,
						},
					],
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: "Failed to verify memory: " + String(error) }],
				};
			}
		},
	);

	server.tool(
		"promote_memory",
		"Promote a memory to a more durable layer. Use when a provisional memory has been confirmed enough to be considered established or permanent. Layers in ascending durability: current → mid_ground → long_embedded → core.",
		{
			id: z.string().describe("Memory ID"),
			target_layer: z.enum(LAYERS).describe("Target durability layer"),
		},
		async ({ id, target_layer }) => {
			try {
				await updateMemory(id, userId, { layer: target_layer } as any, env);
				return {
					content: [{ type: "text", text: `Memory ${id} promoted to ${target_layer}.` }],
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: "Failed to promote memory: " + String(error) }],
				};
			}
		},
	);

	server.tool(
		"query_memories",
		"Semantic search across memories using natural language. Returns the most relevant memories ranked by similarity score. Use this to find what you know about a topic before responding. Supports optional filtering by category and layer.",
		{
			query: z
				.string()
				.describe(
					"Natural language search query (e.g., 'What programming languages does the user prefer?')",
				),
			category: z.enum(CATEGORIES).optional().describe("Filter to a specific category"),
			layer: z.enum(LAYERS).optional().describe("Filter to a specific layer"),
			limit: z.number().optional().default(10).describe("Max results (default 10)"),
		},
		async ({ query, category, layer, limit }) => {
			try {
				// Over-fetch for filter + hybrid re-rank
				const vectorResults = await searchMemories(query, userId, env, Math.max(limit * 3, 15));
				const boosts = new Map<
					string,
					{ salience?: number; confidence?: number; pinned?: boolean; access_count?: number }
				>();
				let results = vectorResults;
				if (category || layer || vectorResults.length > 0) {
					const filtered = [];
					for (const r of vectorResults) {
						const mem = await getMemoryById(r.id, userId, env);
						if (!mem || mem.suppressed) continue;
						if (category && mem.category !== category) continue;
						if (layer && mem.layer !== layer) continue;
						boosts.set(r.id, {
							salience: mem.salience,
							confidence: mem.confidence,
							pinned: mem.pinned,
							access_count: mem.access_count,
						});
						filtered.push(r);
					}
					results = filtered;
				}

				results = rerankMatches(query, results, boosts).slice(0, limit);

				if (results.length === 0) {
					// Keyword fallback when semantic search is empty
					const keywordHits = await fulltextSearchMemories(userId, query, env, limit);
					if (keywordHits.length === 0) {
						return { content: [{ type: "text", text: "No relevant memories found." }] };
					}
					const formattedKw = keywordHits
						.map((m) => `[${m.id}] [keyword] ${m.text}`)
						.join("\n");
					await touchMemoryAccessBatch(
						keywordHits.map((m) => m.id),
						userId,
						env,
					);
					return {
						content: [
							{
								type: "text",
								text: `Found ${keywordHits.length} memories (keyword fallback):\n${formattedKw}`,
							},
						],
					};
				}

				await touchMemoryAccessBatch(
					results.map((r) => r.id),
					userId,
					env,
				);

				const formatted = results
					.map((r) => `[${r.id}] (score: ${r.score.toFixed(3)}) ${r.content}`)
					.join("\n");
				return {
					content: [
						{ type: "text", text: `Found ${results.length} memories:\n${formatted}` },
					],
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: "Failed to query memories: " + String(error) }],
				};
			}
		},
	);

	server.tool(
		"query_memories_by_date",
		"Retrieve memories created within a date range. Use this to review what was learned during a specific period or to audit recent memory activity.",
		{
			start_date: z.string().describe("Start date in ISO format (e.g., '2024-01-01')"),
			end_date: z.string().describe("End date in ISO format (e.g., '2024-01-31')"),
			category: z.enum(CATEGORIES).optional(),
			layer: z.enum(LAYERS).optional(),
		},
		async (params) => {
			try {
				const memories = await queryMemoriesByDate(
					userId,
					params.start_date,
					params.end_date,
					env,
					{
						category: params.category,
						layer: params.layer,
					},
				);
				if (memories.length === 0) {
					return {
						content: [{ type: "text", text: "No memories found in date range." }],
					};
				}
				const formatted = memories
					.map((m) => `[${m.id}] ${m.created_at} [${m.category}/${m.layer}] ${m.text}`)
					.join("\n");
				return {
					content: [
						{ type: "text", text: `Found ${memories.length} memories:\n${formatted}` },
					],
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: "Failed to query by date: " + String(error) }],
				};
			}
		},
	);

	server.tool(
		"search_by_tag",
		"Find memories that match specific tags. Use this for exact tag-based retrieval when you know the relevant tags, as opposed to semantic search with query_memories.",
		{
			tags: z
				.array(z.string())
				.min(1)
				.describe("Tags to search for — returns memories matching ANY of these tags"),
			limit: z.number().optional().default(50).describe("Max results"),
		},
		async ({ tags, limit }) => {
			try {
				const memories = await queryMemoriesByTags(userId, tags, env, limit);
				if (memories.length === 0) {
					return {
						content: [
							{
								type: "text",
								text: `No memories found with tags: ${tags.join(", ")}`,
							},
						],
					};
				}
				const formatted = memories
					.map((m) => `[${m.id}] [${m.tags.join(", ")}] ${m.text}`)
					.join("\n");
				return {
					content: [
						{
							type: "text",
							text: `${memories.length} memories matching tags [${tags.join(
								", ",
							)}]:\n${formatted}`,
						},
					],
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: "Failed to search by tag: " + String(error) }],
				};
			}
		},
	);

	server.tool(
		"smart_context",
		"Retrieve the most relevant context for a topic by combining semantic search with metadata filtering. Use this when preparing to respond about a specific subject — it returns a curated set of memories optimized for context injection.",
		{
			query: z.string().describe("Topic or question to get context for"),
			categories: z
				.array(z.enum(CATEGORIES))
				.optional()
				.describe("Restrict to specific categories"),
			max_results: z.number().optional().default(15).describe("Max memories to return"),
		},
		async ({ query, categories, max_results }) => {
			try {
				const vectorResults = await searchMemories(query, userId, env, max_results * 2);
				let results = vectorResults;

				if (categories?.length) {
					const filtered = [];
					for (const r of vectorResults) {
						const mem = await getMemoryById(r.id, userId, env);
						if (mem && categories.includes(mem.category as any)) filtered.push(r);
					}
					results = filtered;
				}

				results = results.slice(0, max_results);

				if (results.length === 0) {
					return { content: [{ type: "text", text: "No relevant context found." }] };
				}

				const formatted = results
					.map((r) => `- ${r.content} (relevance: ${r.score.toFixed(3)})`)
					.join("\n");
				return {
					content: [{ type: "text", text: `Context for "${query}":\n${formatted}` }],
				};
			} catch (error) {
				return {
					content: [
						{ type: "text", text: "Failed to get smart context: " + String(error) },
					],
				};
			}
		},
	);

	server.tool(
		"get_memory_context",
		"Get a specific memory with its full context: metadata, linked people, and semantically related memories. Use this to deeply inspect a single memory and understand its connections.",
		{ id: z.string().describe("Memory ID") },
		async ({ id }) => {
			try {
				const memory = await getMemoryById(id, userId, env);
				if (!memory)
					return { content: [{ type: "text", text: `Memory ${id} not found.` }] };

				const related = await searchMemories(memory.text, userId, env, 5);
				const relatedFiltered = related.filter((r) => r.id !== id);

				let text = `Memory [${memory.id}]:\n`;
				text += `Category: ${memory.category} | Layer: ${memory.layer} | Source: ${memory.source_type}\n`;
				text += `Confidence: ${memory.confidence} | Salience: ${memory.salience} | Emotion: ${memory.emotion_weight}\n`;
				text += `Tags: ${memory.tags.join(", ")} | Triggers: ${memory.triggers.join(
					", ",
				)}\n`;
				text += `Created: ${memory.created_at} | Updated: ${memory.updated_at}\n`;
				if (memory.last_verified) text += `Last verified: ${memory.last_verified}\n`;
				if (memory.suppressed) text += `SUPPRESSED: ${memory.suppression_reason}\n`;
				text += `Content: ${memory.text}\n`;
				if (memory.linked_people.length > 0)
					text += `Linked people: ${memory.linked_people.join(", ")}\n`;
				if (relatedFiltered.length > 0) {
					text += `\nRelated memories:\n${relatedFiltered
						.map((r) => `- [${r.id}] (${r.score.toFixed(3)}) ${r.content}`)
						.join("\n")}`;
				}

				return { content: [{ type: "text", text }] };
			} catch (error) {
				return {
					content: [
						{ type: "text", text: "Failed to get memory context: " + String(error) },
					],
				};
			}
		},
	);

	server.tool(
		"list_memories",
		"List memories with optional filtering. Use this for browsing/paginating through memories rather than searching. For finding specific memories, use query_memories (semantic) or search_by_tag instead.",
		{
			category: z.enum(CATEGORIES).optional().describe("Filter by category"),
			layer: z.enum(LAYERS).optional().describe("Filter by layer"),
			limit: z.number().optional().default(25).describe("Results per page"),
			offset: z.number().optional().default(0).describe("Pagination offset"),
		},
		async (params) => {
			try {
				const memories = await queryMemories(userId, env, { ...params, suppressed: false });
				if (memories.length === 0) {
					return { content: [{ type: "text", text: "No memories found." }] };
				}
				const formatted = memories
					.map(
						(m) =>
							`[${m.id}] [${m.category}/${m.layer}] conf:${m.confidence.toFixed(2)} ${
								m.text
							}`,
					)
					.join("\n");
				return {
					content: [{ type: "text", text: `${memories.length} memories:\n${formatted}` }],
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: "Failed to list memories: " + String(error) }],
				};
			}
		},
	);

	server.tool(
		"get_suppressed_memories",
		"List memories that have been suppressed (soft-deleted). Shows the suppression reason for each. Use this to audit what's been removed and potentially restore memories with restore_memory.",
		{
			limit: z.number().optional().default(50).describe("Max results"),
		},
		async ({ limit }) => {
			try {
				const memories = await getSuppressedMemories(userId, env, limit);
				if (memories.length === 0) {
					return { content: [{ type: "text", text: "No suppressed memories." }] };
				}
				const formatted = memories
					.map(
						(m) =>
							`[${m.id}] ${m.text}\n   Reason: ${m.suppression_reason ?? "unknown"}`,
					)
					.join("\n");
				return {
					content: [
						{
							type: "text",
							text: `${memories.length} suppressed memories:\n${formatted}`,
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: "Failed to list suppressed memories: " + String(error),
						},
					],
				};
			}
		},
	);

	server.tool(
		"get_memory_index",
		"Get a statistical overview of the memory store: total count, counts by category and layer, embedding status. Use this to understand the state of the memory system at a glance.",
		{},
		async () => {
			try {
				const index = await getMemoryIndex(userId, env);
				let text = `Memory Index (${index.total} total):\n\n`;
				text += `Embedded: ${index.embedded} | Pending: ${index.pending_embedding} | Suppressed: ${index.suppressed}\n\n`;
				text +=
					"By category:\n" +
					Object.entries(index.by_category)
						.map(([k, v]) => `  ${k}: ${v}`)
						.join("\n");
				text +=
					"\n\nBy layer:\n" +
					Object.entries(index.by_layer)
						.map(([k, v]) => `  ${k}: ${v}`)
						.join("\n");
				return { content: [{ type: "text", text }] };
			} catch (error) {
				return {
					content: [
						{ type: "text", text: "Failed to get memory index: " + String(error) },
					],
				};
			}
		},
	);

	server.tool(
		"connection_map",
		"Visualize connections between a memory (by ID or search query) and related memories/people. Shows a network of semantically related memories to understand how topics interconnect.",
		{
			query: z.string().describe("Memory ID or natural language search query"),
			depth: z
				.number()
				.optional()
				.default(2)
				.describe(
					"How many levels of connections to follow (each level fetches 5 related memories)",
				),
		},
		async ({ query, depth }) => {
			try {
				const rootMemory = await getMemoryById(query, userId, env);
				let searchQuery = query;
				if (rootMemory) {
					searchQuery = rootMemory.text;
				}

				const related = await searchMemories(searchQuery, userId, env, depth * 5);
				if (related.length === 0) {
					return { content: [{ type: "text", text: "No connections found." }] };
				}

				let text = `Connection map for "${searchQuery.slice(0, 50)}...":\n`;
				for (const r of related) {
					const mem = await getMemoryById(r.id, userId, env);
					const tags = mem ? ` [${mem.tags.join(", ")}]` : "";
					text += `\n→ (${r.score.toFixed(3)}) ${r.content}${tags}`;
				}
				return { content: [{ type: "text", text }] };
			} catch (error) {
				return {
					content: [
						{ type: "text", text: "Failed to build connection map: " + String(error) },
					],
				};
			}
		},
	);

	server.tool(
		"memory_timeline",
		"Show a chronological timeline of memories, optionally filtered by category or date range. Useful for understanding the user's journey and how information evolved over time.",
		{
			category: z.enum(CATEGORIES).optional().describe("Filter to a category"),
			days: z.number().optional().default(30).describe("How many days back to look"),
			limit: z.number().optional().default(50).describe("Max memories to show"),
		},
		async ({ category, days, limit }) => {
			try {
				const start = new Date(Date.now() - days * 86400000).toISOString();
				const end = new Date().toISOString();
				const memories = await queryMemoriesByDate(userId, start, end, env, { category });
				const limited = memories.slice(0, limit);

				if (limited.length === 0) {
					return {
						content: [{ type: "text", text: `No memories in the last ${days} days.` }],
					};
				}

				const reversed = [...limited].reverse();
				const formatted = reversed
					.map((m) => {
						const date = m.created_at.split("T")[0];
						return `${date} [${m.category}] ${m.text}`;
					})
					.join("\n");

				return {
					content: [
						{
							type: "text",
							text: `Timeline (last ${days} days, ${limited.length} memories):\n${formatted}`,
						},
					],
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: "Failed to build timeline: " + String(error) }],
				};
			}
		},
	);

	server.tool(
		"export_memories",
		"Export all active memories as a structured JSON document. Use this for backup, transfer, or inspection of the complete memory state.",
		{
			include_suppressed: z
				.boolean()
				.optional()
				.default(false)
				.describe("Include suppressed memories in the export"),
		},
		async ({ include_suppressed }) => {
			try {
				const active = await queryMemories(userId, env, { limit: 1000, suppressed: false });
				let suppressed: any[] = [];
				if (include_suppressed) {
					suppressed = await getSuppressedMemories(userId, env, 1000);
				}

				const all = [...active, ...suppressed];
				const exported = {
					exported_at: new Date().toISOString(),
					userId,
					total: all.length,
					active: active.length,
					suppressed: suppressed.length,
					memories: all.map((m) => ({
						id: m.id,
						text: m.text,
						category: m.category,
						layer: m.layer,
						subject: m.subject,
						tags: m.tags,
						triggers: m.triggers,
						confidence: m.confidence,
						salience: m.salience,
						emotion_weight: m.emotion_weight,
						source_type: m.source_type,
						linked_people: m.linked_people,
						suppressed: m.suppressed,
						suppression_reason: m.suppression_reason,
						created_at: m.created_at,
						updated_at: m.updated_at,
					})),
				};

				return { content: [{ type: "text", text: JSON.stringify(exported, null, 2) }] };
			} catch (error) {
				return {
					content: [
						{ type: "text", text: "Failed to export memories: " + String(error) },
					],
				};
			}
		},
	);

	server.tool(
		"bulk_tag_memories",
		"Add tags to multiple memories at once. Useful for organizing or categorizing a batch of related memories after the fact.",
		{
			memory_ids: z.array(z.string()).min(1).describe("Memory IDs to tag"),
			tags: z.array(z.string()).min(1).describe("Tags to add to each memory"),
		},
		async ({ memory_ids, tags }) => {
			try {
				let updated = 0;
				for (const id of memory_ids) {
					const mem = await getMemoryById(id, userId, env);
					if (!mem) continue;
					const merged = [...new Set([...mem.tags, ...tags])];
					await updateMemory(id, userId, { tags: merged } as any, env);
					updated++;
				}
				return {
					content: [
						{
							type: "text",
							text: `Tagged ${updated} of ${
								memory_ids.length
							} memories with [${tags.join(", ")}].`,
						},
					],
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: "Failed to bulk tag: " + String(error) }],
				};
			}
		},
	);

	server.tool(
		"analyze_patterns",
		"Use AI to analyze stored memories for recurring themes, behavioral tendencies, and preference clusters. Optionally focus on a specific category or topic.",
		{
			category: z.enum(CATEGORIES).optional().describe("Focus on a specific category"),
			query: z.string().optional().describe("Focus on a specific topic via semantic search"),
		},
		async ({ category, query }) => {
			try {
				let memories: Memory[];
				if (query) {
					const results = await searchMemories(query, userId, env, 30);
					const fullMemories = [];
					for (const r of results) {
						const m = await getMemoryById(r.id, userId, env);
						if (m) fullMemories.push(m);
					}
					memories = fullMemories;
				} else {
					memories = await queryMemories(userId, env, {
						category,
						limit: 50,
						suppressed: false,
					});
				}

				if (memories.length === 0) {
					return {
						content: [
							{ type: "text", text: "Not enough memories to analyze patterns." },
						],
					};
				}

				const analysis = await analyzePatterns(
					memories.map((m) => ({
						text: m.text,
						category: m.category,
						tags: m.tags,
					})),
					env,
				);

				return {
					content: [
						{
							type: "text",
							text: `Pattern Analysis (${memories.length} memories):\n\n${analysis}`,
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{ type: "text", text: "Failed to analyze patterns: " + String(error) },
					],
				};
			}
		},
	);

	server.tool(
		"generate_pattern_report",
		"Generate a comprehensive report analyzing patterns across all memory categories. Includes memory statistics and AI-driven theme analysis.",
		{},
		async () => {
			try {
				const memories = await queryMemories(userId, env, {
					limit: 100,
					suppressed: false,
				});
				if (memories.length === 0) {
					return { content: [{ type: "text", text: "No memories to report on." }] };
				}

				const analysis = await analyzePatterns(
					memories.map((m) => ({
						text: m.text,
						category: m.category,
						tags: m.tags,
					})),
					env,
				);

				const index = await getMemoryIndex(userId, env);
				let report = `# Pattern Report\n\n`;
				report += `Total memories: ${index.total}\n`;
				report += `Categories: ${Object.keys(index.by_category).length}\n`;
				report += `Layers: ${Object.entries(index.by_layer)
					.map(([k, v]) => `${k}(${v})`)
					.join(", ")}\n\n`;
				report += analysis;

				return { content: [{ type: "text", text: report }] };
			} catch (error) {
				return {
					content: [
						{ type: "text", text: "Failed to generate report: " + String(error) },
					],
				};
			}
		},
	);

	server.tool(
		"backfill_embeddings",
		"Generate vector embeddings for all memories that are still pending. Run this after bulk imports or if embeddings failed during normal writes.",
		{},
		async () => {
			try {
				const unembedded = await getUnembeddedMemories(userId, env);
				if (unembedded.length === 0) {
					return {
						content: [{ type: "text", text: "All memories are already embedded." }],
					};
				}

				let success = 0;
				let failed = 0;
				for (const m of unembedded) {
					try {
						await embedMemory(m, userId, env);
						success++;
					} catch {
						failed++;
					}
				}

				return {
					content: [
						{
							type: "text",
							text: `Backfill complete: ${success} embedded, ${failed} failed out of ${unembedded.length} pending.`,
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{ type: "text", text: "Failed to backfill embeddings: " + String(error) },
					],
				};
			}
		},
	);

	server.tool(
		"embed_memory",
		"Generate or regenerate the vector embedding for a single memory. Use this to fix a specific memory's embedding or after editing its text.",
		{ id: z.string().describe("Memory ID") },
		async ({ id }) => {
			try {
				const memory = await getMemoryById(id, userId, env);
				if (!memory)
					return { content: [{ type: "text", text: `Memory ${id} not found.` }] };

				await embedMemory(memory, userId, env);

				return { content: [{ type: "text", text: `Memory ${id} embedded successfully.` }] };
			} catch (error) {
				return {
					content: [{ type: "text", text: "Failed to embed memory: " + String(error) }],
				};
			}
		},
	);

	server.tool(
		"backfill_emotion_weights",
		"Recompute emotion weights for all memories using AI analysis. Run this to recalibrate emotional significance scores across the memory store.",
		{},
		async () => {
			try {
				const memories = await queryMemories(userId, env, {
					limit: 100,
					suppressed: false,
				});
				let updated = 0;
				for (const m of memories) {
					const triage = await triageText(m.text, env);
					if (triage.emotion_weight !== m.emotion_weight) {
						await updateMemory(
							m.id,
							userId,
							{ emotion_weight: triage.emotion_weight } as any,
							env,
						);
						updated++;
					}
				}
				return {
					content: [
						{
							type: "text",
							text: `Emotion weights updated for ${updated} out of ${memories.length} memories.`,
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: "Failed to backfill emotion weights: " + String(error),
						},
					],
				};
			}
		},
	);

	server.tool(
		"auto_triage",
		"Analyze text using AI to determine if it's worth storing as a memory. Returns suggested category, layer, confidence, salience, emotion weight, and tags. Does NOT store the memory — use write_memory with the suggested values if you want to store it.",
		{ text: z.string().describe("Text to triage") },
		async ({ text }) => {
			try {
				const result = await triageText(text, env);
				let response = `Triage result:\n`;
				response += `Worth storing: ${result.worth_storing}\n`;
				response += `Category: ${result.category}\n`;
				response += `Layer: ${result.layer}\n`;
				response += `Confidence: ${result.confidence}\n`;
				response += `Salience: ${result.salience}\n`;
				response += `Emotion weight: ${result.emotion_weight}\n`;
				response += `Subject: ${result.subject}\n`;
				response += `Tags: ${result.tags.join(", ")}`;
				return { content: [{ type: "text", text: response }] };
			} catch (error) {
				return { content: [{ type: "text", text: "Failed to triage: " + String(error) }] };
			}
		},
	);

	server.tool(
		"run_consolidation",
		"Find and merge duplicate or highly similar memories. Keeps the higher-confidence version and suppresses the duplicate. Run periodically to keep the memory store clean.",
		{
			similarity_threshold: z
				.number()
				.optional()
				.default(0.92)
				.describe(
					"Similarity score (0-1) above which memories are considered duplicates. Default 0.92.",
				),
		},
		async ({ similarity_threshold }) => {
			try {
				const memories = await queryMemories(userId, env, {
					limit: 200,
					suppressed: false,
				});
				let consolidated = 0;

				for (let i = 0; i < memories.length; i++) {
					const m = memories[i];
					if (m.suppressed) continue;

					const similar = await searchMemories(m.text, userId, env, 5);
					for (const s of similar) {
						if (s.id === m.id) continue;
						if (s.score >= similarity_threshold) {
							const existing = await getMemoryById(s.id, userId, env);
							if (existing && !existing.suppressed) {
								const keepHigher =
									m.confidence >= (existing.confidence ?? 0) ? m : existing;
								const suppress = keepHigher.id === m.id ? existing : m;
								await updateMemory(
									suppress.id,
									userId,
									{
										suppressed: true,
										suppression_reason: `Consolidated with ${
											keepHigher.id
										} (similarity: ${s.score.toFixed(3)})`,
									} as any,
									env,
								);
								consolidated++;
							}
						}
					}
				}

				return {
					content: [
						{
							type: "text",
							text: `Consolidation complete: ${consolidated} duplicate memories suppressed.`,
						},
					],
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: "Failed to consolidate: " + String(error) }],
				};
			}
		},
	);

	server.tool(
		"run_decay_sweep",
		"Apply confidence decay to old, unverified memories. Non-core memories older than 30 days that haven't been recently verified lose confidence. Memories that drop below the minimum threshold are flagged for reverification. Run periodically to keep the memory store honest.",
		{
			decay_rate: z
				.number()
				.optional()
				.default(0.02)
				.describe("How much confidence to subtract per sweep (default 0.02)"),
			min_confidence: z
				.number()
				.optional()
				.default(0.3)
				.describe("Floor below which confidence won't drop (default 0.3)"),
		},
		async ({ decay_rate, min_confidence }) => {
			try {
				const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
				const memories = await queryMemories(userId, env, {
					suppressed: false,
					limit: 500,
				});
				let decayed = 0;
				let flagged = 0;

				for (const m of memories) {
					if (m.layer === "core") continue;
					if (m.last_verified && m.last_verified > thirtyDaysAgo) continue;

					const daysSinceCreated =
						(Date.now() - new Date(m.created_at).getTime()) / 86400000;
					if (daysSinceCreated < 30) continue;

					const newConfidence = Math.max(min_confidence, m.confidence - decay_rate);
					if (newConfidence !== m.confidence) {
						await updateMemory(m.id, userId, { confidence: newConfidence } as any, env);
						decayed++;
						if (newConfidence <= min_confidence + 0.1) flagged++;
					}
				}

				return {
					content: [
						{
							type: "text",
							text: `Decay sweep: ${decayed} memories decayed, ${flagged} flagged for reverification.`,
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{ type: "text", text: "Failed to run decay sweep: " + String(error) },
					],
				};
			}
		},
	);

	server.tool(
		"list_reverify_queue",
		"List memories that need reverification because their confidence has decayed below threshold or they haven't been verified recently. Present these to the user for confirmation.",
		{
			days_old: z
				.number()
				.optional()
				.default(30)
				.describe("Minimum age in days for inclusion"),
		},
		async ({ days_old }) => {
			try {
				const memories = await getMemoriesNeedingReverification(userId, env, days_old);
				if (memories.length === 0) {
					return {
						content: [{ type: "text", text: "No memories need reverification." }],
					};
				}
				const formatted = memories
					.map(
						(m) =>
							`[${m.id}] confidence:${m.confidence.toFixed(2)} [${m.category}] ${
								m.text
							}`,
					)
					.join("\n");
				return {
					content: [
						{
							type: "text",
							text: `${memories.length} memories need reverification:\n${formatted}`,
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{ type: "text", text: "Failed to list reverify queue: " + String(error) },
					],
				};
			}
		},
	);

	// ── High-value convenience tools ──

	server.tool(
		"remember",
		"Quick-store a memory with AI triage. Automatically categorizes, scores confidence/salience, detects duplicates, and embeds. Prefer this over write_memory when you don't want to pick metadata manually.",
		{
			text: z.string().describe("Fact or preference to remember"),
			force: z
				.boolean()
				.optional()
				.default(false)
				.describe("Store even if triage says not worth storing"),
		},
		async ({ text, force }) => {
			try {
				const triage = await triageText(text, env);
				if (!triage.worth_storing && !force) {
					return toolText(
						`Not stored (triage: not worth storing). Category would be ${triage.category}. Pass force=true to store anyway.`,
					);
				}

				const existing = await searchMemories(text, userId, env, 3);
				const dup = existing.find((e) => e.score > 0.92);
				if (dup) {
					return toolText(
						`Skipped — near-duplicate of [${dup.id}] (score ${dup.score.toFixed(3)}): ${dup.content}`,
					);
				}

				const memory = await insertMemory(
					{
						userId,
						text,
						category: triage.category as any,
						layer: triage.layer as any,
						confidence: triage.confidence,
						salience: triage.salience,
						emotion_weight: triage.emotion_weight,
						tags: triage.tags,
						subject: triage.subject,
						source_type: "stated",
					},
					env,
				);

				try {
					await embedMemory(memory, userId, env);
				} catch (e) {
					console.error("remember embed failed:", e);
				}

				return toolText(
					`Remembered [${memory.id}] as ${triage.category}/${triage.layer} (conf ${triage.confidence}, sal ${triage.salience}): ${text}`,
				);
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.tool(
		"recall",
		"Best-effort hybrid recall for a topic: semantic search + keyword search + re-ranking by salience/pins/access. Use this as the primary 'what do I know about X?' tool.",
		{
			query: z.string().describe("Topic or question to recall about"),
			limit: z.number().optional().default(12).describe("Max memories to return"),
			categories: z.array(z.enum(CATEGORIES)).optional().describe("Optional category filter"),
		},
		async ({ query, limit, categories }) => {
			try {
				const [vectorHits, keywordHits, pinned] = await Promise.all([
					searchMemories(query, userId, env, limit * 3),
					fulltextSearchMemories(userId, query, env, limit),
					getPinnedMemories(userId, env, 20),
				]);

				const byId = new Map<string, { content: string; score: number }>();
				for (const h of vectorHits) byId.set(h.id, { content: h.content, score: h.score });
				for (const m of keywordHits) {
					const prev = byId.get(m.id);
					const kwScore = 0.55;
					if (!prev || kwScore > prev.score * 0.9) {
						byId.set(m.id, {
							content: m.text,
							score: prev ? Math.max(prev.score, kwScore) + 0.05 : kwScore,
						});
					}
				}
				// Always surface pins that loosely match
				const qLower = query.toLowerCase();
				for (const p of pinned) {
					if (
						p.text.toLowerCase().includes(qLower) ||
						p.tags.some((t) => qLower.includes(t.toLowerCase())) ||
						!byId.has(p.id)
					) {
						const prev = byId.get(p.id);
						byId.set(p.id, {
							content: p.text,
							score: (prev?.score ?? 0.5) + 0.15,
						});
					}
				}

				const boosts = new Map<
					string,
					{ salience?: number; confidence?: number; pinned?: boolean; access_count?: number }
				>();
				const candidates = [];
				for (const [id, hit] of byId) {
					const mem = await getMemoryById(id, userId, env);
					if (!mem || mem.suppressed) continue;
					if (categories?.length && !categories.includes(mem.category as any)) continue;
					boosts.set(id, {
						salience: mem.salience,
						confidence: mem.confidence,
						pinned: mem.pinned,
						access_count: mem.access_count,
					});
					candidates.push({
						id,
						content: hit.content,
						score: hit.score,
						category: mem.category,
						layer: mem.layer,
						salience: mem.salience,
					});
				}

				const ranked = rerankMatches(query, candidates, boosts).slice(0, limit);
				if (ranked.length === 0) {
					return toolText(`Nothing recalled for "${query}".`);
				}

				await touchMemoryAccessBatch(
					ranked.map((r) => r.id),
					userId,
					env,
				);

				const lines = ranked.map(
					(r) =>
						`- [${r.id}] (${r.score.toFixed(3)}) ${r.content}${
							boosts.get(r.id)?.pinned ? " 📌" : ""
						}`,
				);
				return toolText(`Recall for "${query}" (${ranked.length}):\n${lines.join("\n")}`);
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.tool(
		"fulltext_search",
		"Keyword/substring search over memory text, subjects, and tags. Use when you need exact word matches rather than semantic similarity.",
		{
			query: z.string().describe("Keywords to search for"),
			limit: z.number().optional().default(25),
		},
		async ({ query, limit }) => {
			try {
				const memories = await fulltextSearchMemories(userId, query, env, limit);
				if (memories.length === 0) {
					return toolText(`No keyword matches for "${query}".`);
				}
				await touchMemoryAccessBatch(
					memories.map((m) => m.id),
					userId,
					env,
				);
				const formatted = memories
					.map((m) => `[${m.id}] [${m.category}] ${m.text}`)
					.join("\n");
				return toolText(`${memories.length} keyword matches:\n${formatted}`);
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.tool(
		"pin_memory",
		"Pin a memory so it is always prioritized in recall and session context. Use for critical standing facts.",
		{ id: z.string().describe("Memory ID to pin") },
		async ({ id }) => {
			try {
				const memory = await getMemoryById(id, userId, env);
				if (!memory) return toolText(`Memory ${id} not found.`);
				await updateMemory(id, userId, { pinned: true } as any, env);
				try {
					await embedMemory({ ...memory, pinned: true }, userId, env);
				} catch {
					/* best effort */
				}
				return toolText(`Memory ${id} pinned.`);
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.tool(
		"unpin_memory",
		"Remove the pin from a memory.",
		{ id: z.string().describe("Memory ID to unpin") },
		async ({ id }) => {
			try {
				const memory = await getMemoryById(id, userId, env);
				if (!memory) return toolText(`Memory ${id} not found.`);
				await updateMemory(id, userId, { pinned: false } as any, env);
				return toolText(`Memory ${id} unpinned.`);
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.tool(
		"list_pinned_memories",
		"List all pinned memories, ordered by salience. Use when loading critical standing context.",
		{ limit: z.number().optional().default(50) },
		async ({ limit }) => {
			try {
				const memories = await getPinnedMemories(userId, env, limit);
				if (memories.length === 0) return toolText("No pinned memories.");
				const formatted = memories
					.map((m) => `📌 [${m.id}] [${m.category}] ${m.text}`)
					.join("\n");
				return toolText(`${memories.length} pinned memories:\n${formatted}`);
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.tool(
		"get_high_salience",
		"Return the highest-salience (most important) active memories. Useful for building a priority context pack.",
		{
			min_salience: z.number().min(0).max(1).optional().default(0.7),
			limit: z.number().optional().default(25),
		},
		async ({ min_salience, limit }) => {
			try {
				const memories = await getHighSalienceMemories(userId, env, min_salience, limit);
				if (memories.length === 0) {
					return toolText(`No memories with salience >= ${min_salience}.`);
				}
				const formatted = memories
					.map(
						(m) =>
							`[${m.id}] sal:${m.salience.toFixed(2)} conf:${m.confidence.toFixed(2)} ${m.text}`,
					)
					.join("\n");
				return toolText(`${memories.length} high-salience memories:\n${formatted}`);
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.tool(
		"batch_write_memories",
		"Store multiple memories in one call. Each item is stored and embedded independently. Best for bulk capture after a long conversation.",
		{
			items: z
				.array(
					z.object({
						text: z.string(),
						category: z.enum(CATEGORIES).optional(),
						layer: z.enum(LAYERS).optional(),
						tags: z.array(z.string()).optional(),
						confidence: z.number().min(0).max(1).optional(),
						salience: z.number().min(0).max(1).optional(),
					}),
				)
				.min(1)
				.max(25)
				.describe("Memories to store (max 25)"),
			skip_duplicates: z
				.boolean()
				.optional()
				.default(true)
				.describe("Skip exact-text duplicates"),
		},
		async ({ items, skip_duplicates }) => {
			try {
				const results: string[] = [];
				let stored = 0;
				let skipped = 0;
				for (const item of items) {
					if (skip_duplicates) {
						const existing = await memoryExistsByText(userId, item.text, env);
						if (existing) {
							skipped++;
							results.push(`skip exact-dup of ${existing.id}: ${item.text.slice(0, 60)}`);
							continue;
						}
					}
					const memory = await insertMemory({ userId, ...item }, env);
					try {
						await embedMemory(memory, userId, env);
					} catch {
						/* pending */
					}
					stored++;
					results.push(`ok [${memory.id}] ${item.text.slice(0, 60)}`);
				}
				return toolText(
					`Batch write: ${stored} stored, ${skipped} skipped.\n${results.join("\n")}`,
				);
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.tool(
		"import_memories",
		"Import memories from a JSON export (from export_memories). Restores text and metadata; regenerates embeddings. Skips IDs that already exist unless overwrite=true.",
		{
			payload: z
				.string()
				.describe("JSON string from export_memories (full document or memories array)"),
			overwrite: z
				.boolean()
				.optional()
				.default(false)
				.describe("If true, update existing IDs; otherwise skip them"),
		},
		async ({ payload, overwrite }) => {
			try {
				const parsed = JSON.parse(payload);
				const items: Array<Record<string, unknown>> = Array.isArray(parsed)
					? parsed
					: Array.isArray(parsed.memories)
						? parsed.memories
						: [];
				if (items.length === 0) {
					return toolText("No memories found in payload.");
				}

				let imported = 0;
				let updated = 0;
				let skipped = 0;
				let failed = 0;

				for (const item of items.slice(0, 200)) {
					const text = String(item.text ?? "").trim();
					if (!text) {
						failed++;
						continue;
					}
					const id = typeof item.id === "string" ? item.id : undefined;
					try {
						if (id) {
							const existing = await getMemoryById(id, userId, env);
							if (existing) {
								if (!overwrite) {
									skipped++;
									continue;
								}
								await updateMemory(
									id,
									userId,
									{
										text,
										category: (item.category as any) ?? existing.category,
										layer: (item.layer as any) ?? existing.layer,
										subject: (item.subject as any) ?? existing.subject,
										tags: (item.tags as any) ?? existing.tags,
										triggers: (item.triggers as any) ?? existing.triggers,
										confidence:
											typeof item.confidence === "number"
												? item.confidence
												: existing.confidence,
										salience:
											typeof item.salience === "number"
												? item.salience
												: existing.salience,
										emotion_weight:
											typeof item.emotion_weight === "number"
												? item.emotion_weight
												: existing.emotion_weight,
										source_type: (item.source_type as any) ?? existing.source_type,
										linked_people:
											(item.linked_people as any) ?? existing.linked_people,
										suppressed: Boolean(item.suppressed ?? false),
										suppression_reason:
											(item.suppression_reason as string | null) ?? null,
										pinned: Boolean(item.pinned ?? existing.pinned),
									} as any,
									env,
								);
								const mem = await getMemoryById(id, userId, env);
								if (mem) {
									try {
										await embedMemory(mem, userId, env);
									} catch {
										/* */
									}
								}
								updated++;
								continue;
							}
						}

						const memory = await insertMemory(
							{
								id,
								userId,
								text,
								category: item.category as any,
								layer: item.layer as any,
								subject: item.subject as any,
								tags: item.tags as any,
								triggers: item.triggers as any,
								confidence: item.confidence as any,
								salience: item.salience as any,
								emotion_weight: item.emotion_weight as any,
								source_type: item.source_type as any,
								linked_people: item.linked_people as any,
								pinned: Boolean(item.pinned),
							},
							env,
						);
						try {
							await embedMemory(memory, userId, env);
						} catch {
							/* */
						}
						imported++;
					} catch (e) {
						console.error("import item failed:", e);
						failed++;
					}
				}

				return toolText(
					`Import complete: ${imported} new, ${updated} updated, ${skipped} skipped, ${failed} failed (of ${items.length}, max 200 processed).`,
				);
			} catch (error) {
				return toolError(error);
			}
		},
	);
}
