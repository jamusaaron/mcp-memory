import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { insertUncertainty, listUncertainties, answerUncertainty } from "../utils/db";

export function registerUncertaintyTools(server: McpServer, env: Env, userId: string) {
    server.tool(
        "ask_user",
        "Record a question for the user when the assistant is uncertain about something. Creates a tracked uncertainty that persists across sessions.",
        {
            question: z.string().describe("The question to ask"),
            context: z.string().optional().describe("Why this question matters"),
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
        "Record the user's answer to a previously asked question.",
        {
            uncertainty_id: z.string().describe("ID of the uncertainty"),
            answer: z.string().describe("The user's answer"),
        },
        async ({ uncertainty_id, answer }) => {
            try {
                await answerUncertainty(uncertainty_id, userId, answer, env);
                return { content: [{ type: "text", text: `Answer recorded for uncertainty ${uncertainty_id}.` }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to record answer: " + String(error) }] };
            }
        }
    );

    server.tool(
        "list_open_uncertainties",
        "List all open questions that haven't been answered yet.",
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
                    return line;
                }).join("\n");
                return { content: [{ type: "text", text: `${uncertainties.length} open uncertainties:\n${formatted}` }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to list uncertainties: " + String(error) }] };
            }
        }
    );
}
