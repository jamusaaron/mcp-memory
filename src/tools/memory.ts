import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { insertMemory, getMemoryById, updateMemory, deleteMemory, queryMemories, queryMemoriesByDate, getMemoryIndex, getMemoriesNeedingReverification, getUnembeddedMemories } from "../utils/db";
import { storeMemoryVector, searchMemories, deleteVectorById } from "../utils/vectorize";
import { triageText, detectContradictions, analyzePatterns, generateSummary } from "../utils/ai";
import { putLivingSummary } from "../utils/kv";
import { CATEGORIES, LAYERS, SOURCE_TYPES } from "../types";

export function registerMemoryTools(server: McpServer, env: Env, userId: string) {
    server.tool(
        "write_memory",
        "Store a new memory with structured metadata. Automatically checks for contradictions, generates embeddings, and triggers downstream rebuilds.",
        {
            text: z.string().describe("The memory content"),
            category: z.enum(CATEGORIES).optional().describe("Memory category"),
            layer: z.enum(LAYERS).optional().describe("Durability tier"),
            subject: z.string().optional().describe("Brief subject/title"),
            tags: z.array(z.string()).optional().describe("Keyword tags"),
            triggers: z.array(z.string()).optional().describe("Keywords that should surface this memory"),
            confidence: z.number().min(0).max(1).optional().describe("Confidence score"),
            salience: z.number().min(0).max(1).optional().describe("Importance/relevance score"),
            emotion_weight: z.number().min(0).max(1).optional().describe("Emotional significance"),
            source_type: z.enum(SOURCE_TYPES).optional().describe("How this was learned"),
            linked_people: z.array(z.string()).optional().describe("IDs of linked people"),
        },
        async (params) => {
            try {
                const existing = await searchMemories(params.text, userId, env, 5);
                const contradictions = await detectContradictions(params.text, existing.map(m => ({ id: m.id, text: m.content, score: m.score })), env);

                for (const c of contradictions) {
                    if (c.contradiction_type === "direct") {
                        await updateMemory(c.existing_id, userId, {
                            suppressed: true,
                            suppression_reason: `Contradicted by newer memory: ${c.explanation}`,
                        } as any, env);
                    }
                }

                const memory = await insertMemory({ userId, ...params }, env);

                try {
                    await storeMemoryVector(memory.id, params.text, userId, env);
                    await updateMemory(memory.id, userId, { embedding_status: "embedded" } as any, env);
                } catch (e) {
                    console.error("Embedding failed:", e);
                }

                let response = `Memory stored [${memory.id}]: ${params.text}`;
                if (contradictions.length > 0) {
                    response += `\n\nContradictions detected and handled:\n${contradictions.map(c => `- ${c.explanation} (${c.contradiction_type})`).join("\n")}`;
                }

                return { content: [{ type: "text", text: response }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to write memory: " + String(error) }] };
            }
        }
    );

    server.tool(
        "edit_memory",
        "Update an existing memory's content or metadata.",
        {
            id: z.string().describe("Memory ID"),
            text: z.string().optional(),
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
                await updateMemory(id, userId, updates as any, env);
                if (updates.text) {
                    await storeMemoryVector(id, updates.text, userId, env);
                }
                return { content: [{ type: "text", text: `Memory ${id} updated.` }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to edit memory: " + String(error) }] };
            }
        }
    );

    server.tool(
        "forget_memory",
        "Delete a memory permanently from both D1 and Vectorize.",
        {
            id: z.string().describe("Memory ID to forget"),
            reason: z.string().optional().describe("Why this memory is being forgotten"),
        },
        async ({ id, reason }) => {
            try {
                await deleteMemory(id, userId, env);
                try { await deleteVectorById(id, env); } catch { /* best effort */ }
                return { content: [{ type: "text", text: `Memory ${id} forgotten.${reason ? ` Reason: ${reason}` : ""}` }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to forget memory: " + String(error) }] };
            }
        }
    );

    server.tool(
        "promote_memory",
        "Move a memory to a more durable layer (e.g., current → mid_ground → long_embedded → core).",
        {
            id: z.string().describe("Memory ID"),
            target_layer: z.enum(LAYERS).describe("Target durability layer"),
        },
        async ({ id, target_layer }) => {
            try {
                await updateMemory(id, userId, { layer: target_layer } as any, env);
                return { content: [{ type: "text", text: `Memory ${id} promoted to ${target_layer}.` }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to promote memory: " + String(error) }] };
            }
        }
    );

    server.tool(
        "query_memories",
        "Semantic search across memories. Combines vector similarity with metadata filtering.",
        {
            query: z.string().describe("Search query"),
            category: z.enum(CATEGORIES).optional(),
            layer: z.enum(LAYERS).optional(),
            limit: z.number().optional().default(10),
        },
        async ({ query, category, layer, limit }) => {
            try {
                const vectorResults = await searchMemories(query, userId, env, limit);

                let results = vectorResults;
                if (category || layer) {
                    const filtered = [];
                    for (const r of vectorResults) {
                        const mem = await getMemoryById(r.id, userId, env);
                        if (!mem) continue;
                        if (category && mem.category !== category) continue;
                        if (layer && mem.layer !== layer) continue;
                        filtered.push(r);
                    }
                    results = filtered;
                }

                if (results.length === 0) {
                    return { content: [{ type: "text", text: "No relevant memories found." }] };
                }

                const formatted = results.map(r => `[${r.id}] (score: ${r.score.toFixed(3)}) ${r.content}`).join("\n");
                return { content: [{ type: "text", text: `Found ${results.length} memories:\n${formatted}` }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to query memories: " + String(error) }] };
            }
        }
    );

    server.tool(
        "query_memories_by_date",
        "Retrieve memories within a date range.",
        {
            start_date: z.string().describe("Start date (ISO format)"),
            end_date: z.string().describe("End date (ISO format)"),
            category: z.enum(CATEGORIES).optional(),
            layer: z.enum(LAYERS).optional(),
        },
        async (params) => {
            try {
                const memories = await queryMemoriesByDate(userId, params.start_date, params.end_date, env, {
                    category: params.category, layer: params.layer,
                });
                if (memories.length === 0) {
                    return { content: [{ type: "text", text: "No memories found in date range." }] };
                }
                const formatted = memories.map(m => `[${m.id}] ${m.created_at} [${m.category}/${m.layer}] ${m.text}`).join("\n");
                return { content: [{ type: "text", text: `Found ${memories.length} memories:\n${formatted}` }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to query by date: " + String(error) }] };
            }
        }
    );

    server.tool(
        "smart_context",
        "Retrieve the most relevant context for a topic. Combines semantic search, keyword matching, and scoring for best results.",
        {
            query: z.string().describe("Topic or question to get context for"),
            categories: z.array(z.enum(CATEGORIES)).optional().describe("Filter by categories"),
            max_results: z.number().optional().default(15),
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

                const formatted = results.map(r => `- ${r.content} (relevance: ${r.score.toFixed(3)})`).join("\n");
                return { content: [{ type: "text", text: `Context for "${query}":\n${formatted}` }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to get smart context: " + String(error) }] };
            }
        }
    );

    server.tool(
        "get_memory_context",
        "Get a specific memory with its full context: linked people, related memories, and metadata.",
        { id: z.string().describe("Memory ID") },
        async ({ id }) => {
            try {
                const memory = await getMemoryById(id, userId, env);
                if (!memory) return { content: [{ type: "text", text: `Memory ${id} not found.` }] };

                const related = await searchMemories(memory.text, userId, env, 5);
                const relatedFiltered = related.filter(r => r.id !== id);

                let text = `Memory [${memory.id}]:\n`;
                text += `Category: ${memory.category} | Layer: ${memory.layer} | Source: ${memory.source_type}\n`;
                text += `Confidence: ${memory.confidence} | Salience: ${memory.salience} | Emotion: ${memory.emotion_weight}\n`;
                text += `Tags: ${memory.tags.join(", ")} | Triggers: ${memory.triggers.join(", ")}\n`;
                text += `Created: ${memory.created_at} | Updated: ${memory.updated_at}\n`;
                text += `Content: ${memory.text}\n`;
                if (memory.linked_people.length > 0) text += `Linked people: ${memory.linked_people.join(", ")}\n`;
                if (relatedFiltered.length > 0) {
                    text += `\nRelated memories:\n${relatedFiltered.map(r => `- [${r.id}] (${r.score.toFixed(3)}) ${r.content}`).join("\n")}`;
                }

                return { content: [{ type: "text", text }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to get memory context: " + String(error) }] };
            }
        }
    );

    server.tool(
        "list_memories",
        "List memories with optional filtering by category, layer, and pagination.",
        {
            category: z.enum(CATEGORIES).optional(),
            layer: z.enum(LAYERS).optional(),
            limit: z.number().optional().default(25),
            offset: z.number().optional().default(0),
        },
        async (params) => {
            try {
                const memories = await queryMemories(userId, env, { ...params, suppressed: false });
                if (memories.length === 0) {
                    return { content: [{ type: "text", text: "No memories found." }] };
                }
                const formatted = memories.map(m => `[${m.id}] [${m.category}/${m.layer}] ${m.text}`).join("\n");
                return { content: [{ type: "text", text: `${memories.length} memories:\n${formatted}` }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to list memories: " + String(error) }] };
            }
        }
    );

    server.tool(
        "get_memory_index",
        "Get a statistical overview of the memory store: counts by category, layer, embedding status.",
        {},
        async () => {
            try {
                const index = await getMemoryIndex(userId, env);
                let text = `Memory Index (${index.total} total):\n\n`;
                text += `Embedded: ${index.embedded} | Pending: ${index.pending_embedding} | Suppressed: ${index.suppressed}\n\n`;
                text += "By category:\n" + Object.entries(index.by_category).map(([k, v]) => `  ${k}: ${v}`).join("\n");
                text += "\n\nBy layer:\n" + Object.entries(index.by_layer).map(([k, v]) => `  ${k}: ${v}`).join("\n");
                return { content: [{ type: "text", text }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to get memory index: " + String(error) }] };
            }
        }
    );

    server.tool(
        "connection_map",
        "Show connections between a memory and related memories/people.",
        {
            query: z.string().describe("Memory ID or search query"),
            depth: z.number().optional().default(2),
        },
        async ({ query, depth }) => {
            try {
                let rootMemory = await getMemoryById(query, userId, env);
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
                return { content: [{ type: "text", text: "Failed to build connection map: " + String(error) }] };
            }
        }
    );

    server.tool(
        "analyze_patterns",
        "Analyze stored memories for patterns, recurring themes, and behavioral tendencies.",
        {
            category: z.enum(CATEGORIES).optional().describe("Focus on specific category"),
            query: z.string().optional().describe("Focus on specific topic"),
        },
        async ({ category, query }) => {
            try {
                let memories;
                if (query) {
                    const results = await searchMemories(query, userId, env, 30);
                    const fullMemories = [];
                    for (const r of results) {
                        const m = await getMemoryById(r.id, userId, env);
                        if (m) fullMemories.push(m);
                    }
                    memories = fullMemories;
                } else {
                    memories = await queryMemories(userId, env, { category, limit: 50, suppressed: false });
                }

                if (memories.length === 0) {
                    return { content: [{ type: "text", text: "Not enough memories to analyze patterns." }] };
                }

                const analysis = await analyzePatterns(memories.map(m => ({
                    text: m.text, category: m.category, tags: m.tags,
                })), env);

                return { content: [{ type: "text", text: `Pattern Analysis (${memories.length} memories):\n\n${analysis}` }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to analyze patterns: " + String(error) }] };
            }
        }
    );

    server.tool(
        "generate_pattern_report",
        "Generate a comprehensive report of patterns across all memory categories.",
        {},
        async () => {
            try {
                const memories = await queryMemories(userId, env, { limit: 100, suppressed: false });
                if (memories.length === 0) {
                    return { content: [{ type: "text", text: "No memories to report on." }] };
                }

                const analysis = await analyzePatterns(memories.map(m => ({
                    text: m.text, category: m.category, tags: m.tags,
                })), env);

                const index = await getMemoryIndex(userId, env);
                let report = `# Pattern Report\n\n`;
                report += `Total memories: ${index.total}\n`;
                report += `Categories: ${Object.keys(index.by_category).length}\n`;
                report += `Layers: ${Object.entries(index.by_layer).map(([k, v]) => `${k}(${v})`).join(", ")}\n\n`;
                report += analysis;

                return { content: [{ type: "text", text: report }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to generate report: " + String(error) }] };
            }
        }
    );

    server.tool(
        "backfill_embeddings",
        "Generate vector embeddings for all memories that don't have them yet.",
        {},
        async () => {
            try {
                const unembedded = await getUnembeddedMemories(userId, env);
                if (unembedded.length === 0) {
                    return { content: [{ type: "text", text: "All memories are already embedded." }] };
                }

                let success = 0;
                let failed = 0;
                for (const m of unembedded) {
                    try {
                        await storeMemoryVector(m.id, m.text, userId, env);
                        await updateMemory(m.id, userId, { embedding_status: "embedded" } as any, env);
                        success++;
                    } catch {
                        failed++;
                    }
                }

                return { content: [{ type: "text", text: `Backfill complete: ${success} embedded, ${failed} failed out of ${unembedded.length} pending.` }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to backfill embeddings: " + String(error) }] };
            }
        }
    );

    server.tool(
        "embed_memory",
        "Generate or regenerate the vector embedding for a specific memory.",
        { id: z.string().describe("Memory ID") },
        async ({ id }) => {
            try {
                const memory = await getMemoryById(id, userId, env);
                if (!memory) return { content: [{ type: "text", text: `Memory ${id} not found.` }] };

                await storeMemoryVector(id, memory.text, userId, env);
                await updateMemory(id, userId, { embedding_status: "embedded" } as any, env);

                return { content: [{ type: "text", text: `Memory ${id} embedded successfully.` }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to embed memory: " + String(error) }] };
            }
        }
    );

    server.tool(
        "backfill_emotion_weights",
        "Recompute emotion weights for all memories using AI analysis.",
        {},
        async () => {
            try {
                const memories = await queryMemories(userId, env, { limit: 100, suppressed: false });
                let updated = 0;
                for (const m of memories) {
                    const triage = await triageText(m.text, env);
                    if (triage.emotion_weight !== m.emotion_weight) {
                        await updateMemory(m.id, userId, { emotion_weight: triage.emotion_weight } as any, env);
                        updated++;
                    }
                }
                return { content: [{ type: "text", text: `Emotion weights updated for ${updated} out of ${memories.length} memories.` }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to backfill emotion weights: " + String(error) }] };
            }
        }
    );

    server.tool(
        "auto_triage",
        "Analyze text and determine if it's worth storing, with suggested category, layer, and confidence.",
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
        }
    );

    server.tool(
        "run_consolidation",
        "Find and merge duplicate or highly similar memories.",
        { similarity_threshold: z.number().optional().default(0.92) },
        async ({ similarity_threshold }) => {
            try {
                const memories = await queryMemories(userId, env, { limit: 200, suppressed: false });
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
                                const keepHigher = m.confidence >= (existing.confidence ?? 0) ? m : existing;
                                const suppress = keepHigher.id === m.id ? existing : m;
                                await updateMemory(suppress.id, userId, {
                                    suppressed: true,
                                    suppression_reason: `Consolidated with ${keepHigher.id} (similarity: ${s.score.toFixed(3)})`,
                                } as any, env);
                                consolidated++;
                            }
                        }
                    }
                }

                return { content: [{ type: "text", text: `Consolidation complete: ${consolidated} duplicate memories suppressed.` }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to consolidate: " + String(error) }] };
            }
        }
    );

    server.tool(
        "run_decay_sweep",
        "Run confidence decay on old memories. Flags low-confidence, old memories for reverification.",
        {
            decay_rate: z.number().optional().default(0.02),
            min_confidence: z.number().optional().default(0.3),
        },
        async ({ decay_rate, min_confidence }) => {
            try {
                const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
                const memories = await queryMemories(userId, env, { suppressed: false, limit: 500 });
                let decayed = 0;
                let flagged = 0;

                for (const m of memories) {
                    if (m.layer === "core") continue;
                    if (m.last_verified && m.last_verified > thirtyDaysAgo) continue;

                    const daysSinceCreated = (Date.now() - new Date(m.created_at).getTime()) / 86400000;
                    if (daysSinceCreated < 30) continue;

                    const newConfidence = Math.max(min_confidence, m.confidence - decay_rate);
                    if (newConfidence !== m.confidence) {
                        await updateMemory(m.id, userId, { confidence: newConfidence } as any, env);
                        decayed++;
                        if (newConfidence <= min_confidence + 0.1) flagged++;
                    }
                }

                return { content: [{ type: "text", text: `Decay sweep: ${decayed} memories decayed, ${flagged} flagged for reverification.` }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to run decay sweep: " + String(error) }] };
            }
        }
    );

    server.tool(
        "list_reverify_queue",
        "List memories that need reverification due to low confidence or staleness.",
        { days_old: z.number().optional().default(30) },
        async ({ days_old }) => {
            try {
                const memories = await getMemoriesNeedingReverification(userId, env, days_old);
                if (memories.length === 0) {
                    return { content: [{ type: "text", text: "No memories need reverification." }] };
                }
                const formatted = memories.map(m =>
                    `[${m.id}] confidence:${m.confidence.toFixed(2)} [${m.category}] ${m.text}`
                ).join("\n");
                return { content: [{ type: "text", text: `${memories.length} memories need reverification:\n${formatted}` }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to list reverify queue: " + String(error) }] };
            }
        }
    );
}
