import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { insertSessionLog, getSessionLogs, getRecentSessions, getMemoryIndex, getWriteActivity, listUncertainties, getPinnedMemories, getMemoriesNeedingReverification } from "../utils/db";
import { putSessionState } from "../utils/kv";
import { writeStaticFile, readStaticFile } from "../utils/static-context";
import {
    artifactFailureCode,
    rebuildDerivedArtifact,
    resolveActiveDerivedArtifact,
} from "../utils/artifact-service";
import { toolError, toolStructured } from "../utils/tool-result";
import {
    ARTIFACT_KINDS,
    ARTIFACT_STATUSES,
    type ArtifactKind,
    type ArtifactStatus,
    type DerivedArtifact,
} from "../types";

/** Shared read-only projection of a trusted artifact for MCP structured output. */
export type ArtifactToolView = {
    id: string;
    kind: ArtifactKind;
    version: number;
    status: ArtifactStatus;
    validation_state: "validated" | "legacy_unverified";
    rendered_text: string | null;
    eligible_source_count: number;
    selected_source_count: number;
    source_truncated: boolean;
    created_at: string;
    published_at: string | null;
};

export const artifactToolViewSchema = z.object({
    id: z.string(),
    kind: z.enum(ARTIFACT_KINDS),
    version: z.number().int().positive(),
    status: z.enum(ARTIFACT_STATUSES),
    validation_state: z.enum(["validated", "legacy_unverified"]),
    rendered_text: z.string().nullable(),
    eligible_source_count: z.number().int().nonnegative(),
    selected_source_count: z.number().int().nonnegative(),
    source_truncated: z.boolean(),
    created_at: z.string(),
    published_at: z.string().nullable(),
});

export const coverageSchema = z.object({
    eligible: z.number().int().nonnegative(),
    selected: z.number().int().nonnegative(),
    truncated: z.boolean(),
});

export function artifactFreshnessLabel(
    artifact: Pick<DerivedArtifact, "status" | "validation_state">,
): "current" | "stale" | "legacy-unverified" {
    if (artifact.validation_state === "legacy_unverified") {
        return "legacy-unverified";
    }
    return artifact.status === "stale" ? "stale" : "current";
}

export function artifactView(artifact: DerivedArtifact): ArtifactToolView {
    return {
        id: artifact.id,
        kind: artifact.kind,
        version: artifact.version,
        status: artifact.status,
        validation_state: artifact.validation_state,
        rendered_text: artifact.rendered_text,
        eligible_source_count: artifact.eligible_source_count,
        selected_source_count: artifact.selected_source_count,
        source_truncated: Boolean(artifact.source_truncated),
        created_at: artifact.created_at,
        published_at: artifact.published_at,
    };
}

/**
 * Artifact operations surface provider/model detail in their exception text.
 * Callers translate failures into a stable machine code so tool errors never
 * echo raw model or provider messages back to the client.
 */
export function artifactToolError(action: string, error: unknown) {
    return toolError(new Error(`${action} failed (${artifactFailureCode(error)}).`));
}

export function artifactSectionHeading(
    title: string,
    artifact: Pick<DerivedArtifact, "status" | "validation_state">,
): string {
    const label = artifactFreshnessLabel(artifact);
    return label === "current" ? title : `${title} (${label})`;
}

/**
 * The session brief aggregates several independent subsystems. A degraded
 * subsystem must not delete the rest of the brief, so every non-artifact read
 * falls back to an empty value instead of failing the whole call.
 */
async function safeRead<T>(read: () => Promise<T>, fallback: T): Promise<T> {
    try {
        return await read();
    } catch {
        return fallback;
    }
}

export const getLivingSummaryOutputSchema = z.object({
    available: z.boolean(),
    artifact: artifactToolViewSchema.nullable(),
});

export const rebuildLivingSummaryOutputSchema = z.object({
    artifact_id: z.string(),
    version: z.number().int().positive(),
    freshness: z.enum(["current", "stale", "legacy-unverified"]),
    validation_state: z.enum(["validated", "legacy_unverified"]),
    coverage: coverageSchema,
    rendered_text: z.string(),
});

export const sessionBriefOutputSchema = z.object({
    generated_at: z.string(),
    artifacts: z.object({
        living_summary: artifactToolViewSchema.nullable(),
        self_profile: artifactToolViewSchema.nullable(),
        behavioral_profile: artifactToolViewSchema.nullable(),
    }),
});

const sessionBriefInputSchema = z.object({
    session_id: z.string().optional(),
});

const emptyInputSchema = z.object({});

export type SessionArtifactDependencies = {
    rebuildDerivedArtifact: typeof rebuildDerivedArtifact;
    resolveActiveDerivedArtifact: typeof resolveActiveDerivedArtifact;
};

const DEFAULT_SESSION_ARTIFACT_DEPS: SessionArtifactDependencies = {
    rebuildDerivedArtifact,
    resolveActiveDerivedArtifact,
};

async function buildSessionBrief(
    userId: string,
    env: Env,
    input: unknown,
    deps: SessionArtifactDependencies,
) {
    const parsed = sessionBriefInputSchema.parse(input ?? {});
    const sid = parsed.session_id ?? uuidv4();
    await safeRead(
        () =>
            putSessionState(
                userId,
                sid,
                JSON.stringify({ started: new Date().toISOString() }),
                env,
            ),
        undefined,
    );

    const [
        living,
        self,
        behavioral,
        recentSessions,
        index,
        contextCurrent,
        pinned,
        openQs,
        reverify,
    ] = await Promise.all([
        safeRead(
            () => deps.resolveActiveDerivedArtifact(userId, "living_summary", env),
            null,
        ),
        safeRead(
            () => deps.resolveActiveDerivedArtifact(userId, "self_profile", env),
            null,
        ),
        safeRead(
            () => deps.resolveActiveDerivedArtifact(userId, "behavioral_profile", env),
            null,
        ),
        safeRead(() => getRecentSessions(userId, env, 3), []),
        safeRead(() => getMemoryIndex(userId, env), null),
        safeRead(() => readStaticFile(userId, "context_current", env), null),
        safeRead(() => getPinnedMemories(userId, env, 10), []),
        safeRead(() => listUncertainties(userId, env, "open"), []),
        safeRead(() => getMemoriesNeedingReverification(userId, env, 30), []),
    ]);

    let brief = `# Session Brief (${sid})\n\n`;
    if (index) {
        brief += `## Memory Store\n${index.total} memories across ${Object.keys(index.by_category).length} categories`;
        brief += ` | embedded ${index.embedded} | pending ${index.pending_embedding} | suppressed ${index.suppressed}\n\n`;
    }

    if (living?.rendered_text) {
        brief += `## ${artifactSectionHeading("Living Summary", living)}\n${living.rendered_text}\n\n`;
    }

    if (self?.rendered_text) {
        const text = self.rendered_text;
        brief += `## ${artifactSectionHeading("Self Profile", self)}\n${text.slice(0, 1500)}${text.length > 1500 ? "…" : ""}\n\n`;
    }

    if (behavioral?.rendered_text) {
        const text = behavioral.rendered_text;
        brief += `## ${artifactSectionHeading("Behavioral Profile", behavioral)}\n${text.slice(0, 1500)}${text.length > 1500 ? "…" : ""}\n\n`;
    }

    if (contextCurrent) {
        brief += `## Current Context\n${contextCurrent}\n\n`;
    }

    if (pinned.length > 0) {
        brief += `## Pinned Memories\n`;
        for (const p of pinned) {
            brief += `- 📌 [${p.category}] ${p.text}\n`;
        }
        brief += "\n";
    }

    if (openQs.length > 0) {
        brief += `## Open Uncertainties (${openQs.length})\n`;
        for (const u of openQs.slice(0, 8)) {
            brief += `- [${u.id}] ${u.question}\n`;
        }
        if (openQs.length > 8) brief += `- …and ${openQs.length - 8} more\n`;
        brief += "\n";
    }

    if (reverify.length > 0) {
        brief += `## Needs Reverification (${reverify.length})\n`;
        for (const m of reverify.slice(0, 5)) {
            brief += `- conf ${m.confidence.toFixed(2)}: ${m.text.slice(0, 100)}\n`;
        }
        brief += "\n";
    }

    if (recentSessions.length > 0) {
        brief += `## Recent Sessions\n`;
        for (const s of recentSessions) {
            brief += `- ${s.session_id}: ${s.entries} entries (last: ${s.last_entry})\n`;
        }
    }

    await safeRead(
        () => insertSessionLog(userId, sid, "log", "Session started", env),
        undefined,
    );

    return toolStructured(brief, {
        generated_at: new Date().toISOString(),
        artifacts: {
            living_summary: living ? artifactView(living) : null,
            self_profile: self ? artifactView(self) : null,
            behavioral_profile: behavioral ? artifactView(behavioral) : null,
        },
    });
}

export function createSessionArtifactHandlers(
    userId: string,
    env: Env,
    deps: SessionArtifactDependencies = DEFAULT_SESSION_ARTIFACT_DEPS,
) {
    return {
        async getLivingSummary(_input: unknown) {
            try {
                const artifact = await deps.resolveActiveDerivedArtifact(
                    userId,
                    "living_summary",
                    env,
                );
                if (!artifact?.rendered_text) {
                    return toolStructured(
                        "No living summary exists yet. Use rebuild_living_summary to generate one.",
                        { available: false, artifact: null },
                    );
                }
                return toolStructured(artifact.rendered_text, {
                    available: true,
                    artifact: artifactView(artifact),
                });
            } catch (error) {
                return artifactToolError("Living summary read", error);
            }
        },
        async rebuildLivingSummary(_input: unknown) {
            try {
                const result = await deps.rebuildDerivedArtifact(
                    userId,
                    "living_summary",
                    env,
                );
                const artifact = result.artifact;
                return toolStructured(
                    `Living summary ${result.reused ? "reused" : "rebuilt"} as ${
                        artifact.id
                    }.\n\n${artifact.rendered_text ?? ""}`,
                    {
                        artifact_id: artifact.id,
                        version: artifact.version,
                        freshness: artifactFreshnessLabel(artifact),
                        validation_state: artifact.validation_state,
                        coverage: {
                            eligible: artifact.eligible_source_count,
                            selected: artifact.selected_source_count,
                            truncated: Boolean(artifact.source_truncated),
                        },
                        rendered_text: artifact.rendered_text ?? "",
                    },
                );
            } catch (error) {
                return artifactToolError("Living summary rebuild", error);
            }
        },
        async getSessionBrief(input: unknown) {
            try {
                return await buildSessionBrief(userId, env, input, deps);
            } catch (error) {
                return artifactToolError("Session brief", error);
            }
        },
    };
}

export function registerSessionTools(
    server: McpServer,
    env: Env,
    userId: string,
    deps: SessionArtifactDependencies = DEFAULT_SESSION_ARTIFACT_DEPS,
) {
    const handlers = createSessionArtifactHandlers(userId, env, deps);

    server.registerTool(
        "get_session_brief",
        {
            description:
                "Start a new session by loading the user's trusted living summary, self profile, behavioural profile, recent activity, and current context. Call this at the beginning of every conversation to ensure continuity across sessions. Returns a comprehensive brief including memory store stats, pinned memories, open uncertainties, the approved artifacts, current context, and recent session history.",
            inputSchema: sessionBriefInputSchema,
            outputSchema: sessionBriefOutputSchema,
        },
        handlers.getSessionBrief,
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
        "Close the current session with a summary and optional carry-forward items. The carry-forward content is saved to the current context file so it's available in the next session's brief. Call this at the end of conversations.",
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

                return { content: [{ type: "text", text: `Session ${session_id} closed.` }] };
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

    server.registerTool(
        "get_living_summary",
        {
            description:
                "Retrieve the active living summary — the approved, citation-backed overview of everything known about the user. If none exists, use rebuild_living_summary to generate one.",
            inputSchema: emptyInputSchema,
            outputSchema: getLivingSummaryOutputSchema,
        },
        handlers.getLivingSummary,
    );

    server.registerTool(
        "rebuild_living_summary",
        {
            description:
                "Regenerate the living summary from eligible memories as a validated derived artifact. The rebuilt version is published with coverage counts and citations. Run this after significant memory changes or periodically to keep the summary current.",
            inputSchema: emptyInputSchema,
            outputSchema: rebuildLivingSummaryOutputSchema,
        },
        handlers.rebuildLivingSummary,
    );

    server.tool(
        "update_context_current",
        "Update the current context document — a persistent note stored in KV that tracks what's happening right now across sessions. This is included in every session brief automatically.",
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
