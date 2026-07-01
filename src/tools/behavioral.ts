import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { insertBehavioralObservation, getBehavioralObservations, insertPersonalityFeedback, getPersonalityFeedback } from "../utils/db";
import { getPersonalityCache, putPersonalityCache, getBehavioralCache, putBehavioralCache } from "../utils/kv";
import { readStaticFile, writeStaticFile } from "../utils/r2";
import { llmCall } from "../utils/ai";

export function registerBehavioralTools(server: McpServer, env: Env, userId: string) {
    server.tool(
        "behavioral_model",
        "Get or rebuild the behavioral model — a rolling summary of communication patterns, corrections, and preferences.",
        { rebuild: z.boolean().optional().default(false).describe("Force rebuild from observations") },
        async ({ rebuild }) => {
            try {
                if (!rebuild) {
                    const cached = await getBehavioralCache(userId, env);
                    if (cached) return { content: [{ type: "text", text: cached }] };
                }

                const observations = await getBehavioralObservations(userId, env, undefined, 100);
                if (observations.length === 0) {
                    return { content: [{ type: "text", text: "No behavioral observations recorded yet." }] };
                }

                const items = observations.map(o => `[${o.observation_type}] ${o.content}`).join("\n");
                const model = await llmCall(
                    `Build a behavioral model from these observations about a user's communication patterns. Organize into: communication style, correction patterns, preference signals, and behavioral tendencies.\n\n${items}`,
                    env
                );

                await putBehavioralCache(userId, model, env);
                return { content: [{ type: "text", text: model }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to get behavioral model: " + String(error) }] };
            }
        }
    );

    server.tool(
        "emotional_context",
        "Record or retrieve emotional context — how the user is feeling, mood signals, emotional patterns.",
        {
            observation: z.string().optional().describe("New emotional observation to record"),
            query: z.boolean().optional().default(false).describe("Just retrieve current emotional context"),
        },
        async ({ observation, query }) => {
            try {
                if (observation) {
                    await insertBehavioralObservation(userId, "emotional", observation, null, env);
                }

                if (query || observation) {
                    const moodTracker = await readStaticFile(userId, "mood_tracker", env);
                    const recent = await getBehavioralObservations(userId, env, "emotional", 10);

                    let text = "";
                    if (moodTracker) text += `Mood tracker:\n${moodTracker}\n\n`;
                    if (recent.length > 0) {
                        text += `Recent emotional observations:\n${recent.map(o => `- [${o.created_at}] ${o.content}`).join("\n")}`;
                    }
                    if (!text) text = "No emotional context recorded.";

                    return { content: [{ type: "text", text }] };
                }

                return { content: [{ type: "text", text: "Provide an observation or set query=true." }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed: " + String(error) }] };
            }
        }
    );

    server.tool(
        "get_personality",
        "Get the current personality profile — the assistant's configured personality traits and interaction style.",
        {},
        async () => {
            try {
                const cached = await getPersonalityCache(userId, env);
                if (cached) return { content: [{ type: "text", text: cached }] };

                const personality = await readStaticFile(userId, "ai_personality", env);
                if (personality) {
                    await putPersonalityCache(userId, personality, env);
                    return { content: [{ type: "text", text: personality }] };
                }

                return { content: [{ type: "text", text: "No personality profile configured. Use build_personality to create one." }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to get personality: " + String(error) }] };
            }
        }
    );

    server.tool(
        "get_personality_mode",
        "Get the active personality mode/style for a given situation.",
        { situation: z.string().describe("Current situation or context") },
        async ({ situation }) => {
            try {
                const styles = await readStaticFile(userId, "personality_styles", env);
                const feedback = await getPersonalityFeedback(userId, env, undefined, 20);

                let context = "";
                if (styles) context += `Available styles:\n${styles}\n\n`;
                if (feedback.length > 0) {
                    context += `Recent feedback:\n${feedback.map(f => `- ${f.situation}: ${f.tone}/${f.mode} → ${f.outcome} (score: ${f.feedback_score})`).join("\n")}`;
                }

                if (!context) {
                    return { content: [{ type: "text", text: "No personality modes configured. Use build_personality to set up styles." }] };
                }

                const recommendation = await llmCall(
                    `Given this situation: "${situation}"\n\nAnd these personality styles/feedback:\n${context}\n\nRecommend the best tone and mode for this interaction. Be specific and brief.`,
                    env
                );

                return { content: [{ type: "text", text: recommendation }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to get personality mode: " + String(error) }] };
            }
        }
    );

    server.tool(
        "build_personality",
        "Build or rebuild the personality profile from behavioral observations and feedback history.",
        {},
        async () => {
            try {
                const observations = await getBehavioralObservations(userId, env, undefined, 100);
                const feedback = await getPersonalityFeedback(userId, env, undefined, 50);

                let input = "";
                if (observations.length > 0) {
                    input += `Behavioral observations:\n${observations.map(o => `- [${o.observation_type}] ${o.content}`).join("\n")}\n\n`;
                }
                if (feedback.length > 0) {
                    input += `Personality feedback:\n${feedback.map(f => `- Situation: ${f.situation}, Tone: ${f.tone}, Mode: ${f.mode}, Outcome: ${f.outcome}, Score: ${f.feedback_score}`).join("\n")}`;
                }

                if (!input) {
                    return { content: [{ type: "text", text: "No data to build personality from. Record behavioral observations and personality feedback first." }] };
                }

                const personality = await llmCall(
                    `Build a personality profile for an AI assistant based on this interaction data. Include: core traits, communication style, adaptation patterns, and recommended default mode.\n\n${input}`,
                    env
                );

                await writeStaticFile(userId, "ai_personality", personality, env);
                await putPersonalityCache(userId, personality, env);

                return { content: [{ type: "text", text: `Personality profile built and saved:\n\n${personality}` }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to build personality: " + String(error) }] };
            }
        }
    );

    server.tool(
        "personality_feedback",
        "Log feedback on how a particular tone/mode worked in a situation. Aggregates into the self-tuning style profile.",
        {
            persona: z.string().optional().default("default"),
            tone: z.string().describe("Tone used (e.g., casual, formal, empathetic)"),
            mode: z.string().describe("Mode used (e.g., teaching, collaborative, direct)"),
            situation: z.string().describe("The situation or context"),
            outcome: z.string().describe("How it landed / what happened"),
            feedback_score: z.number().min(-1).max(1).describe("Score: -1 (bad) to 1 (great)"),
        },
        async (params) => {
            try {
                await insertPersonalityFeedback(userId, params, env);
                await insertBehavioralObservation(userId, "tone_feedback",
                    `${params.tone}/${params.mode} in "${params.situation}" → ${params.outcome} (${params.feedback_score})`,
                    null, env
                );

                return { content: [{ type: "text", text: `Personality feedback recorded: ${params.tone}/${params.mode} scored ${params.feedback_score}.` }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to record feedback: " + String(error) }] };
            }
        }
    );
}
