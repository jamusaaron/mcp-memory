import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { insertBehavioralObservation, getBehavioralObservations, insertPersonalityFeedback, getPersonalityFeedback } from "../utils/db";
import { getPersonalityCache, putPersonalityCache } from "../utils/kv";
import { readStaticFile, writeStaticFile } from "../utils/static-context";
import { llmCall } from "../utils/ai";
import {
    rebuildDerivedArtifact,
    resolveActiveDerivedArtifact,
} from "../utils/artifact-service";
import { buildArtifactInvalidationStatements } from "../utils/artifact-store";
import { toolStructured } from "../utils/tool-result";
import { artifactToolError, artifactToolViewSchema, artifactView } from "./session";
import { ARTIFACT_STATUSES } from "../types";

export const behavioralModelOutputSchema = z.object({
    available: z.boolean(),
    rebuilt: z.boolean(),
    status: z.enum(ARTIFACT_STATUSES).nullable(),
    artifact: artifactToolViewSchema.nullable(),
    review_required: z.boolean(),
});

export const recordObservationOutputSchema = z.object({
    id: z.string(),
    observation_type: z.string(),
    source_type: z.enum(["stated", "observed", "inferred"]),
    confidence: z.number().min(0).max(1),
    verified: z.boolean(),
});

const behavioralModelInputSchema = z.object({
    rebuild: z.boolean().optional().default(false).describe("Rebuild a reviewable behavioural profile candidate from all stored observations"),
});

const recordObservationInputSchema = z.object({
    observation_type: z.string().describe("Type of observation: 'communication' (style patterns), 'correction' (user corrected the assistant), 'preference' (implicit preference signal), 'emotional' (mood/feeling), 'tone_feedback' (how a tone landed)"),
    content: z.string().describe("What was observed"),
    context: z.string().optional().describe("The situation in which this was observed"),
    source_type: z.enum(["stated", "observed", "inferred"])
        .optional()
        .default("observed")
        .describe("Where the observation came from"),
    confidence: z.number().min(0).max(1).optional().default(0.5).describe("How confident this observation is"),
    verified: z.boolean().optional().default(false).describe("Whether the user confirmed this observation"),
});

export type ObservationRecord = {
    observation_type: string;
    content: string;
    context: string | null;
    source_type: "stated" | "observed" | "inferred";
    confidence: number;
    verified: boolean;
    verified_at: string | null;
};

/**
 * Writes the observation row and its behavioural-profile invalidation in a
 * single batch, matching `insertBehavioralObservation` while also persisting
 * the provenance columns added by migration v4.
 */
async function insertObservationRecord(
    userId: string,
    record: ObservationRecord,
    env: Env,
): Promise<string> {
    const id = uuidv4();
    const statements = [
        env.DB.prepare(
            `INSERT INTO behavioral_observations
             (id,userId,observation_type,content,context,source_type,confidence,verified_at)
             VALUES (?,?,?,?,?,?,?,?)`,
        ).bind(
            id,
            userId,
            record.observation_type,
            record.content,
            record.context,
            record.source_type,
            record.confidence,
            record.verified_at,
        ),
        ...buildArtifactInvalidationStatements(
            env,
            userId,
            ["behavioral_profile"],
            "behavioral_observation_changed",
            "memory_tool",
            { kind: "behavioral_observation", id },
        ),
    ];
    if (typeof env.DB.batch === "function") {
        await env.DB.batch(statements);
    } else {
        for (const statement of statements) await statement.run();
    }
    return id;
}

export type BehavioralArtifactDependencies = {
    rebuildDerivedArtifact: typeof rebuildDerivedArtifact;
    resolveActiveDerivedArtifact: typeof resolveActiveDerivedArtifact;
    insertObservation: typeof insertObservationRecord;
};

const DEFAULT_BEHAVIORAL_ARTIFACT_DEPS: BehavioralArtifactDependencies = {
    rebuildDerivedArtifact,
    resolveActiveDerivedArtifact,
    insertObservation: insertObservationRecord,
};

export function createBehavioralArtifactHandlers(
    userId: string,
    env: Env,
    deps: BehavioralArtifactDependencies = DEFAULT_BEHAVIORAL_ARTIFACT_DEPS,
) {
    return {
        async behavioralModel(input: unknown) {
            try {
                const { rebuild } = behavioralModelInputSchema.parse(input ?? {});
                if (rebuild) {
                    const result = await deps.rebuildDerivedArtifact(
                        userId,
                        "behavioral_profile",
                        env,
                    );
                    const artifact = result.artifact;
                    return toolStructured(
                        `Behavioural profile candidate ${artifact.id} (version ${artifact.version}) is inactive until reviewed — use review_derived_artifact to approve or reject it.`,
                        {
                            available: false,
                            rebuilt: true,
                            status: "candidate" as const,
                            artifact: artifactView(artifact),
                            review_required: true,
                        },
                    );
                }
                const active = await deps.resolveActiveDerivedArtifact(
                    userId,
                    "behavioral_profile",
                    env,
                );
                if (!active?.rendered_text) {
                    return toolStructured(
                        "No approved behavioural profile yet. Use record_observation to gather evidence, then behavioral_model with rebuild=true to build a reviewable candidate.",
                        {
                            available: false,
                            rebuilt: false,
                            status: null,
                            artifact: null,
                            review_required: false,
                        },
                    );
                }
                return toolStructured(active.rendered_text, {
                    available: true,
                    rebuilt: false,
                    status: active.status,
                    artifact: artifactView(active),
                    review_required: false,
                });
            } catch (error) {
                return artifactToolError("Behavioural model", error);
            }
        },
        async recordObservation(input: unknown) {
            try {
                const parsed = recordObservationInputSchema.parse(input);
                const id = await deps.insertObservation(
                    userId,
                    {
                        observation_type: parsed.observation_type,
                        content: parsed.content,
                        context: parsed.context ?? null,
                        source_type: parsed.source_type,
                        confidence: parsed.confidence,
                        verified: parsed.verified,
                        verified_at: parsed.verified ? new Date().toISOString() : null,
                    },
                    env,
                );
                return toolStructured(
                    `Observation recorded [${id}]: [${parsed.observation_type}] ${parsed.content}`,
                    {
                        id,
                        observation_type: parsed.observation_type,
                        source_type: parsed.source_type,
                        confidence: parsed.confidence,
                        verified: parsed.verified,
                    },
                );
            } catch (error) {
                return artifactToolError("Observation write", error);
            }
        },
    };
}

export function registerBehavioralTools(
    server: McpServer,
    env: Env,
    userId: string,
    deps: BehavioralArtifactDependencies = DEFAULT_BEHAVIORAL_ARTIFACT_DEPS,
) {
    const artifactHandlers = createBehavioralArtifactHandlers(userId, env, deps);

    server.registerTool(
        "record_observation",
        {
            description:
                "Record a behavioral observation about the user — communication patterns, corrections, preferences expressed through behavior rather than explicit statements. Observations feed into the behavioural profile artifact and help the assistant adapt over time.",
            inputSchema: recordObservationInputSchema,
            outputSchema: recordObservationOutputSchema,
        },
        artifactHandlers.recordObservation,
    );

    server.registerTool(
        "behavioral_model",
        {
            description:
                "Retrieve the approved behavioural profile — a citation-backed summary of the user's communication patterns, correction tendencies, and preference signals. Set rebuild=true to build a reviewable candidate from all stored observations; candidates stay out of context until approved.",
            inputSchema: behavioralModelInputSchema,
            outputSchema: behavioralModelOutputSchema,
        },
        artifactHandlers.behavioralModel,
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
                // insertPersonalityFeedback atomically writes both the feedback row
                // and the synthetic tone_feedback observation with a single
                // behavioral_profile invalidation event.
                await insertPersonalityFeedback(userId, params, env);

                return { content: [{ type: "text", text: `Personality feedback recorded: ${params.tone}/${params.mode} scored ${params.feedback_score}.` }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to record feedback: " + String(error) }] };
            }
        }
    );
}
