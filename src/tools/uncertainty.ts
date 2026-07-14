import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { insertUncertainty, listUncertainties, answerUncertainty, dismissUncertainty, getUncertaintyById } from "../utils/db";
import { onUncertaintyResolved } from "../utils/cross-talk";

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
        "Record the user's answer to a previously asked question, marking the uncertainty as resolved. After recording, consider using the answer to update memories or profiles as appropriate.",
        {
            uncertainty_id: z.string().describe("ID of the uncertainty to answer"),
            answer: z.string().describe("The user's answer"),
        },
        async ({ uncertainty_id, answer }) => {
            try {
                const uncertainty = await getUncertaintyById(uncertainty_id, userId, env);
                await answerUncertainty(uncertainty_id, userId, answer, env);
                // Auto-create a memory from the resolved question + answer
                if (uncertainty) {
                    onUncertaintyResolved(userId, uncertainty.question, answer, env).catch(() => {});
                }
                return { content: [{ type: "text", text: `Answer recorded for uncertainty ${uncertainty_id}. A memory has been created from this answer.` }] };
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
