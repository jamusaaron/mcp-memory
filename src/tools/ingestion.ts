import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { insertTranscript, listTranscripts, markTranscriptProcessed, insertMemory } from "../utils/db";
import { storeMemoryVector, searchMemories } from "../utils/vectorize";
import { extractFromTranscript, triageText } from "../utils/ai";

export function registerIngestionTools(server: McpServer, env: Env, userId: string) {
    server.tool(
        "ingest_transcript",
        "Ingest a conversation transcript and extract structured memories from it using AI. The system identifies facts, preferences, and notable information, then either auto-stores high-confidence extractions or proposes them for review. Use this to import chat logs, meeting notes, or any conversational data.",
        {
            source: z.string().describe("Source label for tracking (e.g., 'claude-chat-2024-01', 'slack-export', 'meeting-notes')"),
            content: z.string().describe("Transcript content — the raw text of the conversation"),
            auto_store: z.boolean().optional().default(false).describe("If true, automatically store extractions with confidence >= 0.7. If false, only propose them for review."),
        },
        async ({ source, content, auto_store }) => {
            try {
                const transcriptId = await insertTranscript(userId, source, content, env);

                let extracted: Awaited<ReturnType<typeof extractFromTranscript>>;
                try {
                    extracted = await extractFromTranscript(content, env);
                } catch (e) {
                    return { content: [{ type: "text", text: `Transcript saved [${transcriptId}] but AI extraction is unavailable (${String(e).split("\n")[0]}). The raw transcript is stored — re-run ingest_transcript when Workers AI is reachable, or extract memories manually with write_memory.` }] };
                }

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
        "List all ingested transcripts with their processing status. Shows source, processing state, extraction count, and ingestion date for each transcript.",
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
        "Submit freeform text for AI triage — the system decides whether it's worth storing as a memory. If valuable, it auto-categorizes, scores, and stores it. Duplicates are detected and skipped. Use this as a fire-and-forget way to capture potentially useful information without manually categorizing it.",
        {
            text: z.string().describe("Text to process and potentially store"),
            source: z.string().optional().default("inbound").describe("Source label for tracking"),
        },
        async ({ text, source }) => {
            try {
                let triage: Awaited<ReturnType<typeof triageText>>;
                let triageSkipped = false;
                try {
                    triage = await triageText(text, env);
                } catch (e) {
                    console.error("AI triage unavailable, storing with defaults:", e);
                    triageSkipped = true;
                    triage = {
                        worth_storing: true, category: "knowledge", layer: "current",
                        confidence: 0.6, salience: 0.5, emotion_weight: 0.0,
                        tags: [], subject: text.slice(0, 50),
                    };
                }

                if (!triage.worth_storing) {
                    return { content: [{ type: "text", text: `Triaged as not worth storing. Category: ${triage.category}, Confidence: ${triage.confidence}` }] };
                }

                try {
                    const existing = await searchMemories(text, userId, env, 3);
                    const isDuplicate = existing.some(e => e.score > 0.9);

                    if (isDuplicate) {
                        return { content: [{ type: "text", text: `Triaged as duplicate of existing memory. Closest match: ${existing[0].content} (score: ${existing[0].score.toFixed(3)})` }] };
                    }
                } catch { /* duplicate check needs Vectorize — skip when unavailable */ }

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

                const note = triageSkipped ? " (AI triage unavailable — stored with default categorization; use edit_memory to refine)" : "";
                return { content: [{ type: "text", text: `Stored as memory [${memory.id}]: category=${triage.category}, layer=${triage.layer}, confidence=${triage.confidence}${note}` }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to process inbound: " + String(error) }] };
            }
        }
    );
}
