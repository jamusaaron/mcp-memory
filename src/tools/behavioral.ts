import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { insertBehavioralObservation, getBehavioralObservations, insertPersonalityFeedback, getPersonalityFeedback } from "../utils/db";
import { getPersonalityCache, putPersonalityCache, getBehavioralCache, putBehavioralCache } from "../utils/kv";
import { readStaticFile, writeStaticFile } from "../utils/static-context";
import { llmCall } from "../utils/ai";

export function registerBehavioralTools(server: McpServer, env: Env, userId: string) {
    server.tool(
        "record_observation",
        "Record a behavioral observation about the user — communication patterns, corrections, preferences expressed through behavior rather than explicit statements. Observations feed into the behavioral model and help the assistant adapt over time.",
        {
            observation_type: z.string().describe("Type of observation: 'communication' (style patterns), 'correction' (user corrected the assistant), 'preference' (implicit preference signal), 'emotional' (mood/feeling), 'tone_feedback' (how a tone landed)"),
            content: z.string().describe("What was observed"),
            context: z.string().optional().describe("The situation in which this was observed"),
        },
        async ({ observation_type, content, context }) => {
            try {
                const id = await insertBehavioralObservation(userId, observation_type, content, context ?? null, env);
                return { content: [{ type: "text", text: `Observation recorded [${id}]: [${observation_type}] ${content}` }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to record observation: " + String(error) }] };
            }
        }
    );

    server.tool(
        "behavioral_model",
        "Retrieve or rebuild the behavioral model — an AI-generated summary of the user's communication patterns, correction tendencies, and preference signals. Cached in KV for fast retrieval. Set rebuild=true to regenerate from all observations.",
        { rebuild: z.boolean().optional().default(false).describe("Force rebuild from all stored observations") },
        async ({ rebuild }) => {
            try {
                if (!rebuild) {
                    const cached = await getBehavioralCache(userId, env);
                    if (cached) return { content: [{ type: "text", text: cached }] };
                }

                const observations = await getBehavioralObservations(userId, env, undefined, 100);
                if (observations.length === 0) {
                    return { content: [{ type: "text", text: "No behavioral observations recorded yet. Use record_observation to start building the model." }] };
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
        "Record or retrieve the user's emotional context — mood signals, emotional patterns, and sentiment over time. When recording, pass an observation; when reading, set query=true.",
        {
            observation: z.string().optional().describe("New emotional observation to record (e.g., 'User seems frustrated with debugging session')"),
            query: z.boolean().optional().default(false).describe("Set to true to retrieve current emotional context without recording"),
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
        "Retrieve the assistant's configured personality profile — the traits, style, and interaction guidelines that shape how it communicates. Checks the fast cache first, then persistent KV context. If no profile exists, use build_personality to create one.",
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
        "Get an AI recommendation for the best tone and interaction mode for a given situation, based on configured personality styles and historical feedback. Use this to adapt communication style dynamically.",
        { situation: z.string().describe("Description of the current situation (e.g., 'user is debugging a critical production issue', 'casual conversation about hobbies')") },
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
        "Build or rebuild the assistant's personality profile from behavioral observations and feedback history. Generates core traits, communication style, adaptation patterns, and a default mode. Saves persistent context and updates the fast cache in KV.",
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
                    return { content: [{ type: "text", text: "No data to build personality from. Use record_observation and personality_feedback to provide data first." }] };
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
        "Log feedback on how a specific tone/mode worked in a situation. This feeds the self-tuning loop — over time, the system learns which communication styles work best in which contexts. Score from -1 (terrible) to 1 (perfect).",
        {
            persona: z.string().optional().default("default").describe("Persona name if using multiple personalities"),
            tone: z.string().describe("Tone used (e.g., 'casual', 'formal', 'empathetic', 'technical')"),
            mode: z.string().describe("Interaction mode (e.g., 'teaching', 'collaborative', 'direct', 'supportive')"),
            situation: z.string().describe("What situation this was in"),
            outcome: z.string().describe("How it landed — what happened as a result"),
            feedback_score: z.number().min(-1).max(1).describe("Score: -1 (bad fit) to 1 (great fit)"),
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
