import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { insertUncertainty, listUncertainties, answerUncertainty, dismissUncertainty, getUncertaintyById, insertMemory, updateMemory } from "../utils/db";
import { storeMemoryVector } from "../utils/vectorize";
import { markMemoriesWritten, autoRebuildIfDirty } from "../utils/cascade";
import { CATEGORIES } from "../types";

export function registerUncertaintyTools(server: McpServer, env: Env, userId: string) {
    server.tool(
        "ask_user",
        "Record a question for the user when you're uncertain about something. Creates a tracked question that persists across sessions until answered. Use this to flag things you need to verify rather than guessing — questions appear in session briefs and can be reviewed via list_open_uncertainties.",
        {
            question: z.string().describe("The question to ask the user"),
            context: z.string().optional().describe("Why this question matters or what triggered it"),
        },
        async ({ question, context }) => {
            try {
                const id = await insertUncertainty(userId, question, context ?? null, env);
                return { content: [{ type: "text", text: `Uncertainty recorded [${id}]: ${question}` }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to record question: " + String(error) }] };
            }
        }
    );

    server.tool(
        "record_user_answer",
        "Record the user's answer to a previously asked question, marking the uncertainty as resolved. By default the resolved question/answer is also persisted as a memory (with the write cascade) so the knowledge you just gained isn't lost when the uncertainty is closed — set store_as_memory=false to only close it without storing. Prefer letting it store: an answered question is usually a durable fact worth remembering.",
        {
            uncertainty_id: z.string().describe("ID of the uncertainty to answer"),
            answer: z.string().describe("The user's answer"),
            store_as_memory: z.boolean().optional().default(true).describe("If true (default), also write the resolved Q&A as a memory so it persists and feeds search/summaries. Set false to only mark the uncertainty answered."),
            category: z.enum(CATEGORIES).optional().describe("Category for the stored memory (defaults to 'knowledge')"),
        },
        async ({ uncertainty_id, answer, store_as_memory, category }) => {
            try {
                const uncertainty = await getUncertaintyById(uncertainty_id, userId, env);
                if (!uncertainty) {
                    return { content: [{ type: "text", text: `Uncertainty ${uncertainty_id} not found.` }] };
                }

                await answerUncertainty(uncertainty_id, userId, answer, env);

                let response = `Answer recorded for uncertainty ${uncertainty_id}.`;

                if (store_as_memory) {
                    try {
                        const memoryText = `${uncertainty.question} — ${answer}`;
                        const memory = await insertMemory({
                            userId,
                            text: memoryText,
                            category: (category ?? "knowledge") as any,
                            layer: "current",
                            source_type: "stated",
                            subject: uncertainty.question.slice(0, 60),
                        }, env);

                        try {
                            await storeMemoryVector(memory.id, memoryText, userId, env);
                            await updateMemory(memory.id, userId, { embedding_status: "embedded" } as any, env);
                        } catch { /* embedding best-effort — backfill_embeddings catches up */ }

                        await markMemoriesWritten(userId, env, [memory.category]);
                        await autoRebuildIfDirty(userId, env);

                        response += ` Stored as memory [${memory.id}].`;
                    } catch (e) {
                        response += ` (Could not store as memory: ${String(e)})`;
                    }
                }

                return { content: [{ type: "text", text: response }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to record answer: " + String(error) }] };
            }
        }
    );

    server.tool(
        "dismiss_uncertainty",
        "Dismiss a question without answering it — mark it as no longer relevant. Use this when a question has become moot or the information was obtained through other means.",
        {
            uncertainty_id: z.string().describe("ID of the uncertainty to dismiss"),
        },
        async ({ uncertainty_id }) => {
            try {
                await dismissUncertainty(uncertainty_id, userId, env);
                return { content: [{ type: "text", text: `Uncertainty ${uncertainty_id} dismissed.` }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to dismiss uncertainty: " + String(error) }] };
            }
        }
    );

    server.tool(
        "list_open_uncertainties",
        "List all unanswered questions. Review these periodically and present relevant ones to the user. Each entry shows the question, context, and when it was recorded.",
        {},
        async () => {
            try {
                const uncertainties = await listUncertainties(userId, env);
                if (uncertainties.length === 0) {
                    return { content: [{ type: "text", text: "No open uncertainties." }] };
                }
                const formatted = uncertainties.map(u => {
                    let line = `[${u.id}] ${u.question}`;
                    if (u.context) line += ` (context: ${u.context})`;
                    line += ` — asked ${u.created_at}`;
                    return line;
                }).join("\n");
                return { content: [{ type: "text", text: `${uncertainties.length} open uncertainties:\n${formatted}` }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to list uncertainties: " + String(error) }] };
            }
        }
    );
}
