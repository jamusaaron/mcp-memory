import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { insertTranscript, listTranscripts, markTranscriptProcessed, insertMemory } from "../utils/db";
import { storeMemoryVector, searchMemories } from "../utils/vectorize";
import { extractFromTranscript, triageText } from "../utils/ai";

export function registerIngestionTools(server: McpServer, env: Env, userId: string) {
    server.tool(
        "ingest_transcript",
        "Ingest a conversation transcript and extract structured memories from it. Runs extraction and proposes memories rather than blindly storing everything.",
        {
            source: z.string().describe("Source label (e.g., 'claude-chat-2024-01', 'slack-export')"),
            content: z.string().describe("Transcript content"),
            auto_store: z.boolean().optional().default(false).describe("Automatically store extracted memories"),
        },
        async ({ source, content, auto_store }) => {
            try {
                const transcriptId = await insertTranscript(userId, source, content, env);
                const extracted = await extractFromTranscript(content, env);

                if (extracted.length === 0) {
                    await markTranscriptProcessed(transcriptId, userId, 0, env);
                    return { content: [{ type: "text", text: `Transcript ingested [${transcriptId}] but no extractable memories found.` }] };
                }

                let stored = 0;
                const proposed: string[] = [];

                for (const item of extracted) {
                    if (auto_store && item.confidence >= 0.7) {
                        const memory = await insertMemory({
                            userId,
                            text: item.text,
                            category: item.category as any,
                            source_type: item.source_type as any,
                            confidence: item.confidence,
                            layer: "current",
                        }, env);

                        try {
                            await storeMemoryVector(memory.id, item.text, userId, env);
                            await env.DB.prepare("UPDATE memories SET embedding_status='embedded' WHERE id=?").bind(memory.id).run();
                        } catch { /* best effort */ }

                        stored++;
                    } else {
                        proposed.push(`- [${item.category}] (conf:${item.confidence.toFixed(2)}) ${item.text}`);
                    }
                }

                await markTranscriptProcessed(transcriptId, userId, extracted.length, env);

                let response = `Transcript [${transcriptId}] processed: ${extracted.length} items extracted`;
                if (stored > 0) response += `, ${stored} auto-stored`;
                if (proposed.length > 0) response += `\n\nProposed memories (not yet stored):\n${proposed.join("\n")}`;
                response += "\n\nUse write_memory to store proposed items individually.";

                return { content: [{ type: "text", text: response }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to ingest transcript: " + String(error) }] };
            }
        }
    );

    server.tool(
        "list_transcripts",
        "List all ingested transcripts.",
        {},
        async () => {
            try {
                const transcripts = await listTranscripts(userId, env);
                if (transcripts.length === 0) {
                    return { content: [{ type: "text", text: "No transcripts ingested." }] };
                }
                const formatted = transcripts.map(t =>
                    `[${t.id}] ${t.source} | ${t.processed ? "processed" : "pending"} | ${t.extracted_count} items | ${t.created_at}`
                ).join("\n");
                return { content: [{ type: "text", text: `${transcripts.length} transcripts:\n${formatted}` }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to list transcripts: " + String(error) }] };
            }
        }
    );

    server.tool(
        "submit_inbound",
        "Submit inbound data (text, notes, observations) for triage and potential storage. The system decides what's worth keeping.",
        {
            text: z.string().describe("Inbound text to process"),
            source: z.string().optional().default("inbound").describe("Source label"),
        },
        async ({ text, source }) => {
            try {
                const triage = await triageText(text, env);

                if (!triage.worth_storing) {
                    return { content: [{ type: "text", text: `Triaged as not worth storing. Category: ${triage.category}, Confidence: ${triage.confidence}` }] };
                }

                const existing = await searchMemories(text, userId, env, 3);
                const isDuplicate = existing.some(e => e.score > 0.9);

                if (isDuplicate) {
                    return { content: [{ type: "text", text: `Triaged as duplicate of existing memory. Closest match: ${existing[0].content} (score: ${existing[0].score.toFixed(3)})` }] };
                }

                const memory = await insertMemory({
                    userId,
                    text,
                    category: triage.category as any,
                    layer: triage.layer as any,
                    confidence: triage.confidence,
                    salience: triage.salience,
                    emotion_weight: triage.emotion_weight,
                    tags: triage.tags,
                    subject: triage.subject,
                    source_type: "observed",
                }, env);

                try {
                    await storeMemoryVector(memory.id, text, userId, env);
                    await env.DB.prepare("UPDATE memories SET embedding_status='embedded' WHERE id=?").bind(memory.id).run();
                } catch { /* best effort */ }

                return { content: [{ type: "text", text: `Stored as memory [${memory.id}]: category=${triage.category}, layer=${triage.layer}, confidence=${triage.confidence}` }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to process inbound: " + String(error) }] };
            }
        }
    );
}
