import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { insertSessionLog, getSessionLogs, getRecentSessions, getMemoryIndex, getWriteActivity } from "../utils/db";
import { getLivingSummary, putSessionState, getSessionState } from "../utils/kv";
import { writeStaticFile, readStaticFile } from "../utils/r2";
import { rebuildDirtyOnSessionClose, getStaleness, rebuildLivingSummaryNow } from "../utils/cascade";

export function registerSessionTools(server: McpServer, env: Env, userId: string) {
    server.tool(
        "get_session_brief",
        "Start a new session by loading the user's living summary, recent activity, and current context. Call this at the beginning of every conversation to ensure continuity across sessions. Returns a comprehensive brief including memory store stats, the living summary, current context, and recent session history.",
        { session_id: z.string().optional().describe("Session ID — auto-generated if omitted") },
        async ({ session_id }) => {
            try {
                const sid = session_id ?? uuidv4();
                await putSessionState(userId, sid, JSON.stringify({ started: new Date().toISOString() }), env);

                const summary = await getLivingSummary(userId, env);
                const recentSessions = await getRecentSessions(userId, env, 3);
                const index = await getMemoryIndex(userId, env);
                const contextCurrent = await readStaticFile(userId, "context_current", env);
                const staleness = await getStaleness(userId, env);

                let brief = `# Session Brief (${sid})\n\n`;
                brief += `## Memory Store\n${index.total} memories across ${Object.keys(index.by_category).length} categories\n\n`;

                if (summary) {
                    brief += `## Living Summary\n${summary}\n\n`;
                    if (staleness.livingSummaryDirty > 0) {
                        brief += `_(${staleness.livingSummaryDirty} memory change${staleness.livingSummaryDirty === 1 ? "" : "s"} since this was last built — will auto-refresh at session close, or run rebuild_living_summary now.)_\n\n`;
                    }
                } else if (staleness.livingSummaryDirty > 0) {
                    brief += `## Living Summary\nNot yet built. Run rebuild_living_summary to generate one.\n\n`;
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
        "Add a timestamped entry to the current session's log. Use this to record significant events, decisions, or milestones during a conversation.",
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
        "Record what the user wants to accomplish in this session. Use this early in the conversation to capture goals — the intent is stored in the session log and can be reviewed for follow-up.",
        {
            session_id: z.string().describe("Session ID"),
            intent: z.string().describe("What the user wants to accomplish"),
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
        "Close the current session with a summary and optional carry-forward items. The carry-forward content is saved to the current context file so it's available in the next session's brief. If any memories were written, edited, suppressed, or forgotten during the session, the living summary and self-profile are automatically refreshed from the current memory store. Call this at the end of conversations.",
        {
            session_id: z.string().describe("Session ID"),
            summary: z.string().describe("What happened in this session"),
            carry_forward: z.string().optional().describe("Items, tasks, or context to carry into the next session"),
        },
        async ({ session_id, summary, carry_forward }) => {
            try {
                let closeContent = `Summary: ${summary}`;
                if (carry_forward) closeContent += `\nCarry forward: ${carry_forward}`;

                await insertSessionLog(userId, session_id, "close", closeContent, env);

                if (carry_forward) {
                    await writeStaticFile(userId, "context_current", carry_forward, env);
                }

                const rebuilt = await rebuildDirtyOnSessionClose(userId, env);
                let response = `Session ${session_id} closed.`;
                if (rebuilt.livingSummary) response += " Living summary refreshed.";
                if (rebuilt.selfProfile) response += " Self-profile refreshed.";

                return { content: [{ type: "text", text: response }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to close session: " + String(error) }] };
            }
        }
    );

    server.tool(
        "session_audit",
        "Review a session's complete log — all entries, intents, and close records. Use this to look back at what happened in a specific session.",
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
        "session_list",
        "List recent sessions with entry counts and timestamps. Use this to find a session ID for auditing or to see conversation frequency.",
        {
            limit: z.number().optional().default(10).describe("Number of recent sessions to show"),
        },
        async ({ limit }) => {
            try {
                const sessions = await getRecentSessions(userId, env, limit);
                if (sessions.length === 0) {
                    return { content: [{ type: "text", text: "No sessions recorded yet." }] };
                }
                const formatted = sessions.map(s =>
                    `${s.session_id}: ${s.entries} entries (last activity: ${s.last_entry})`
                ).join("\n");
                return { content: [{ type: "text", text: `${sessions.length} recent sessions:\n${formatted}` }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to list sessions: " + String(error) }] };
            }
        }
    );

    server.tool(
        "check_write_activity",
        "Check how many memories, people, and notes have been created recently. Use this to gauge session productivity or to detect if the system has been quiet.",
        { since_minutes: z.number().optional().default(60).describe("Look back this many minutes (default 60)") },
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
        "Retrieve the cached living summary — a concise, AI-generated overview of everything known about the user. If none exists, use rebuild_living_summary to generate one.",
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
        "Regenerate the living summary from all active memories using AI. The summary is cached in KV for fast retrieval. Run this after significant memory changes or periodically to keep the summary current.",
        {},
        async () => {
            try {
                const summary = await rebuildLivingSummaryNow(userId, env);
                if (!summary) {
                    return { content: [{ type: "text", text: "No memories to summarize." }] };
                }
                return { content: [{ type: "text", text: `Living summary rebuilt:\n\n${summary}` }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to rebuild summary: " + String(error) }] };
            }
        }
    );

    server.tool(
        "update_context_current",
        "Update the current context document — a persistent note (stored in R2) that tracks what's happening right now across sessions. This is included in every session brief automatically.",
        { content: z.string().describe("Current context content (replaces existing)") },
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
