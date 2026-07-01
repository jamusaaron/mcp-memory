import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { insertSessionLog, getSessionLogs, getRecentSessions, queryMemories, getMemoryIndex, getWriteActivity } from "../utils/db";
import { getLivingSummary, putLivingSummary, putSessionState, getSessionState } from "../utils/kv";
import { writeStaticFile, readStaticFile } from "../utils/r2";
import { generateSummary } from "../utils/ai";

export function registerSessionTools(server: McpServer, env: Env, userId: string) {
    server.tool(
        "get_session_brief",
        "Get a brief for starting a new session: living summary, recent activity, and any open items. Call this at the start of each conversation.",
        { session_id: z.string().optional().describe("Session ID (auto-generated if omitted)") },
        async ({ session_id }) => {
            try {
                const sid = session_id ?? uuidv4();
                await putSessionState(userId, sid, JSON.stringify({ started: new Date().toISOString() }), env);

                const summary = await getLivingSummary(userId, env);
                const recentSessions = await getRecentSessions(userId, env, 3);
                const index = await getMemoryIndex(userId, env);
                const contextCurrent = await readStaticFile(userId, "context_current", env);

                let brief = `# Session Brief (${sid})\n\n`;
                brief += `## Memory Store\n${index.total} memories across ${Object.keys(index.by_category).length} categories\n\n`;

                if (summary) {
                    brief += `## Living Summary\n${summary}\n\n`;
                }

                if (contextCurrent) {
                    brief += `## Current Context\n${contextCurrent}\n\n`;
                }

                if (recentSessions.length > 0) {
                    brief += `## Recent Sessions\n`;
                    for (const s of recentSessions) {
                        brief += `- ${s.session_id}: ${s.entries} entries (last: ${s.last_entry})\n`;
                    }
                }

                await insertSessionLog(userId, sid, "log", "Session started", env);

                return { content: [{ type: "text", text: brief }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to get session brief: " + String(error) }] };
            }
        }
    );

    server.tool(
        "append_session_log",
        "Append an entry to the current session log.",
        {
            session_id: z.string().describe("Session ID"),
            content: z.string().describe("Log entry content"),
        },
        async ({ session_id, content }) => {
            try {
                await insertSessionLog(userId, session_id, "log", content, env);
                return { content: [{ type: "text", text: "Session log entry added." }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to append log: " + String(error) }] };
            }
        }
    );

    server.tool(
        "append_session_intent",
        "Record the user's intent or goals for this session.",
        {
            session_id: z.string().describe("Session ID"),
            intent: z.string().describe("User's intent or goals"),
        },
        async ({ session_id, intent }) => {
            try {
                await insertSessionLog(userId, session_id, "intent", intent, env);
                return { content: [{ type: "text", text: "Session intent recorded." }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to record intent: " + String(error) }] };
            }
        }
    );

    server.tool(
        "session_close",
        "Close a session with a summary of what happened and what carries forward.",
        {
            session_id: z.string().describe("Session ID"),
            summary: z.string().describe("Session summary"),
            carry_forward: z.string().optional().describe("Items to carry forward to next session"),
        },
        async ({ session_id, summary, carry_forward }) => {
            try {
                let closeContent = `Summary: ${summary}`;
                if (carry_forward) closeContent += `\nCarry forward: ${carry_forward}`;

                await insertSessionLog(userId, session_id, "close", closeContent, env);

                if (carry_forward) {
                    await writeStaticFile(userId, "context_current", carry_forward, env);
                }

                return { content: [{ type: "text", text: `Session ${session_id} closed.` }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to close session: " + String(error) }] };
            }
        }
    );

    server.tool(
        "session_audit",
        "Review a session's full log.",
        { session_id: z.string().describe("Session ID") },
        async ({ session_id }) => {
            try {
                const logs = await getSessionLogs(userId, session_id, env);
                if (logs.length === 0) {
                    return { content: [{ type: "text", text: `No logs found for session ${session_id}.` }] };
                }
                const formatted = logs.map(l => `[${l.created_at}] (${l.entry_type}) ${l.content}`).join("\n");
                return { content: [{ type: "text", text: `Session ${session_id} audit (${logs.length} entries):\n${formatted}` }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to audit session: " + String(error) }] };
            }
        }
    );

    server.tool(
        "check_write_activity",
        "Check recent write activity (memories, people, notes created in the last N minutes).",
        { since_minutes: z.number().optional().default(60) },
        async ({ since_minutes }) => {
            try {
                const activity = await getWriteActivity(userId, env, since_minutes);
                return { content: [{ type: "text", text: `Write activity (last ${since_minutes}min): ${activity.memories} memories, ${activity.people} people, ${activity.notes} notes` }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to check activity: " + String(error) }] };
            }
        }
    );

    server.tool(
        "get_living_summary",
        "Get the cached living summary of the user.",
        {},
        async () => {
            try {
                const summary = await getLivingSummary(userId, env);
                if (!summary) {
                    return { content: [{ type: "text", text: "No living summary exists yet. Use rebuild_living_summary to generate one." }] };
                }
                return { content: [{ type: "text", text: summary }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to get living summary: " + String(error) }] };
            }
        }
    );

    server.tool(
        "rebuild_living_summary",
        "Regenerate the living summary from all active memories.",
        {},
        async () => {
            try {
                const memories = await queryMemories(userId, env, { limit: 200, suppressed: false });
                if (memories.length === 0) {
                    return { content: [{ type: "text", text: "No memories to summarize." }] };
                }

                const summary = await generateSummary(memories.map(m => ({
                    text: m.text, category: m.category,
                })), env);

                await putLivingSummary(userId, summary, env);

                return { content: [{ type: "text", text: `Living summary rebuilt from ${memories.length} memories:\n\n${summary}` }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to rebuild summary: " + String(error) }] };
            }
        }
    );

    server.tool(
        "update_context_current",
        "Update the current context document (R2-backed). Used to track what's happening right now across sessions.",
        { content: z.string().describe("Current context content") },
        async ({ content }) => {
            try {
                await writeStaticFile(userId, "context_current", content, env);
                return { content: [{ type: "text", text: "Current context updated." }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to update context: " + String(error) }] };
            }
        }
    );
}
