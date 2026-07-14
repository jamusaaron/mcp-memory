import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listAiAgents, listAiNotes, getAiNote, upsertAiNote, deleteAiNote } from "../utils/db";
import { onAgentNoteWrite } from "../utils/cross-talk";

export function registerAiAgentTools(server: McpServer, env: Env, userId: string) {
    server.tool(
        "ai_agents_list",
        "List all AI agents that have left notes in the shared memory space. Each agent is identified by its agent_id string. Use this to discover what agents have been interacting with this user's memory.",
        {},
        async () => {
            try {
                const agents = await listAiAgents(userId, env);
                if (agents.length === 0) {
                    return { content: [{ type: "text", text: "No AI agents have left notes yet." }] };
                }
                return { content: [{ type: "text", text: `${agents.length} agents:\n${agents.map(a => `- ${a}`).join("\n")}` }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to list agents: " + String(error) }] };
            }
        }
    );

    server.tool(
        "ai_note_list",
        "List all notes in the shared AI agent memory space, optionally filtered by agent. Shows agent ID, key, content preview, and last update time. Use this to see what handoffs, findings, or status updates have been shared.",
        { agent_id: z.string().optional().describe("Filter to notes from a specific agent") },
        async ({ agent_id }) => {
            try {
                const notes = await listAiNotes(userId, env, agent_id);
                if (notes.length === 0) {
                    return { content: [{ type: "text", text: "No notes found." }] };
                }
                const formatted = notes.map(n =>
                    `[${n.agent_id}] ${n.key}: ${n.content.slice(0, 100)}${n.content.length > 100 ? "..." : ""} (${n.updated_at})`
                ).join("\n");
                return { content: [{ type: "text", text: `${notes.length} notes:\n${formatted}` }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to list notes: " + String(error) }] };
            }
        }
    );

    server.tool(
        "ai_note_read",
        "Read the full content of a specific note by agent ID and key. Use this to retrieve handoff details, research findings, or status updates left by another agent (or a previous session of yourself).",
        {
            agent_id: z.string().describe("Agent ID that wrote the note"),
            key: z.string().describe("Note key (e.g., 'handoff', 'findings', 'status', 'config')"),
            namespace: z.string().optional().default("default").describe("Namespace for note isolation"),
        },
        async ({ agent_id, key, namespace }) => {
            try {
                const note = await getAiNote(userId, agent_id, key, env, namespace);
                if (!note) {
                    return { content: [{ type: "text", text: `Note not found: ${agent_id}/${key}` }] };
                }
                return { content: [{ type: "text", text: `[${note.agent_id}] ${note.key} (${note.updated_at}):\n${note.content}` }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to read note: " + String(error) }] };
            }
        }
    );

    server.tool(
        "ai_note_write",
        "Write a note to the shared AI agent memory space. Use this for cross-agent communication: handoffs (what you were working on), findings (what you discovered), status updates, or any data that should be available to other agents or future sessions. Overwrites existing notes with the same agent_id/key/namespace.",
        {
            agent_id: z.string().describe("Your agent identifier (e.g., 'claude-code', 'research-agent', 'review-bot')"),
            key: z.string().describe("Note key — a short label for the note's purpose (e.g., 'handoff', 'findings', 'status')"),
            content: z.string().describe("Note content — structured text with the information to share"),
            namespace: z.string().optional().default("default").describe("Namespace for note isolation (default: 'default')"),
        },
        async ({ agent_id, key, content, namespace }) => {
            try {
                const id = await upsertAiNote(userId, agent_id, key, content, env, namespace);
                onAgentNoteWrite(userId, agent_id, key, env).catch(() => {});
                return { content: [{ type: "text", text: `Note saved: ${agent_id}/${key} [${id}]` }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to write note: " + String(error) }] };
            }
        }
    );

    server.tool(
        "ai_note_delete",
        "Delete a note from the shared AI agent memory space. Use this to clean up stale handoffs or outdated status notes.",
        {
            agent_id: z.string().describe("Agent ID that wrote the note"),
            key: z.string().describe("Note key to delete"),
            namespace: z.string().optional().default("default").describe("Namespace"),
        },
        async ({ agent_id, key, namespace }) => {
            try {
                await deleteAiNote(userId, agent_id, key, env, namespace);
                return { content: [{ type: "text", text: `Note deleted: ${agent_id}/${key}` }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to delete note: " + String(error) }] };
            }
        }
    );

    server.tool(
        "ai_notes_cross_check",
        "Cross-check notes across all agents to find overlaps, contradictions, or relevant handoffs. Optionally filter by topic. Use this to get a holistic view of what all agents know or to find potential conflicts in multi-agent workflows.",
        { topic: z.string().optional().describe("Topic keyword to highlight relevant notes") },
        async ({ topic }) => {
            try {
                const allNotes = await listAiNotes(userId, env);
                if (allNotes.length === 0) {
                    return { content: [{ type: "text", text: "No notes to cross-check." }] };
                }

                const byAgent: Record<string, typeof allNotes> = {};
                for (const note of allNotes) {
                    if (!byAgent[note.agent_id]) byAgent[note.agent_id] = [];
                    byAgent[note.agent_id].push(note);
                }

                let report = `Cross-check report (${allNotes.length} notes, ${Object.keys(byAgent).length} agents):\n\n`;

                for (const [agent, notes] of Object.entries(byAgent)) {
                    report += `## ${agent} (${notes.length} notes)\n`;
                    for (const n of notes) {
                        const preview = n.content.slice(0, 80);
                        const relevant = !topic || n.content.toLowerCase().includes(topic.toLowerCase()) || n.key.toLowerCase().includes(topic.toLowerCase());
                        report += `  ${relevant ? "→" : " "} ${n.key}: ${preview}${n.content.length > 80 ? "..." : ""}\n`;
                    }
                    report += "\n";
                }

                return { content: [{ type: "text", text: report }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to cross-check: " + String(error) }] };
            }
        }
    );
}
