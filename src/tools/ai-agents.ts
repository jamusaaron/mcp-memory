import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listAiAgents, listAiNotes, getAiNote, upsertAiNote } from "../utils/db";

export function registerAiAgentTools(server: McpServer, env: Env, userId: string) {
    server.tool(
        "ai_agents_list",
        "List all AI agents that have left notes in the shared memory space.",
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
        "List all notes from a specific AI agent, or all notes if no agent specified.",
        { agent_id: z.string().optional().describe("Filter by agent ID") },
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
        "Read a specific note by agent ID and key.",
        {
            agent_id: z.string().describe("Agent ID"),
            key: z.string().describe("Note key"),
            namespace: z.string().optional().default("default"),
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
        "Write a note to the shared AI agent memory space. Used for handoffs, findings, and cross-agent communication.",
        {
            agent_id: z.string().describe("Your agent ID"),
            key: z.string().describe("Note key (e.g., 'handoff', 'findings', 'status')"),
            content: z.string().describe("Note content"),
            namespace: z.string().optional().default("default"),
        },
        async ({ agent_id, key, content, namespace }) => {
            try {
                const id = await upsertAiNote(userId, agent_id, key, content, env, namespace);
                return { content: [{ type: "text", text: `Note saved: ${agent_id}/${key} [${id}]` }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to write note: " + String(error) }] };
            }
        }
    );

    server.tool(
        "ai_notes_cross_check",
        "Cross-check notes across agents to find overlaps, contradictions, or relevant handoffs.",
        { topic: z.string().optional().describe("Topic to focus cross-check on") },
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
