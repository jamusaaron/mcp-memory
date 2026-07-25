import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { insertPerson, listPeople, getPerson, getPersonProfiles, upsertPersonProfile, insertPendingUpdate, listPendingUpdates, setPendingUpdateStatus, queryMemories, searchPeopleByName, deletePerson, updatePerson } from "../utils/db";
import { extractProfileUpdates } from "../utils/ai";
import { rebuildDerivedArtifact } from "../utils/artifact-service";
import {
    ensureLegacySelfProfileFacts,
    setConfirmedProfileFact,
} from "../utils/profile-facts";
import { toolStructured } from "../utils/tool-result";
import { artifactToolError } from "./session";
import { PROFILE_SECTIONS, SELF_PROFILE_SECTIONS } from "../types";

const claimOutputSchema = z.object({
    id: z.string(),
    section: z.string(),
    text: z.string(),
    confidence: z.number(),
    provenance: z.enum(["stated", "observed", "inferred"]),
    sensitivity: z.enum(["normal", "sensitive"]),
    citations: z.array(z.object({
        source_kind: z.enum([
            "memory",
            "profile_fact",
            "behavioral_observation",
            "personality_feedback",
        ]),
        source_id: z.string(),
    })),
});

export const rebuildProfileOutputSchema = z.object({
    artifact_id: z.string(),
    version: z.number().int().positive(),
    status: z.literal("candidate"),
    claims: z.array(claimOutputSchema),
    validation: z.record(z.unknown()),
    review_required: z.literal(true),
});

export const updateProfileOutputSchema = z.object({
    target: z.enum(["self", "person"]),
    id: z.string(),
    section: z.enum(SELF_PROFILE_SECTIONS),
    field: z.string(),
    updated: z.literal(true),
});

const rebuildSelfProfileInputSchema = z.object({});

const updateProfileInputSchema = z.object({
    person_id: z.string().optional().describe("Person ID (omit to update the user's self-profile)"),
    section: z.enum(SELF_PROFILE_SECTIONS).describe("Profile section"),
    field: z.string().describe("Field name (e.g., 'occupation', 'hobby', 'communication_style')"),
    value: z.string().describe("Field value"),
});

export type PeopleArtifactDependencies = {
    rebuildDerivedArtifact: typeof rebuildDerivedArtifact;
    ensureLegacySelfProfileFacts: typeof ensureLegacySelfProfileFacts;
    setConfirmedProfileFact: typeof setConfirmedProfileFact;
    upsertPersonProfile: typeof upsertPersonProfile;
};

const DEFAULT_PEOPLE_ARTIFACT_DEPS: PeopleArtifactDependencies = {
    rebuildDerivedArtifact,
    ensureLegacySelfProfileFacts,
    setConfirmedProfileFact,
    upsertPersonProfile,
};

export function createPeopleArtifactHandlers(
    userId: string,
    env: Env,
    deps: PeopleArtifactDependencies = DEFAULT_PEOPLE_ARTIFACT_DEPS,
) {
    return {
        async rebuildSelfProfile(_input: unknown) {
            try {
                const result = await deps.rebuildDerivedArtifact(userId, "self_profile", env);
                const artifact = result.artifact;
                return toolStructured(
                    `Self-profile candidate ${artifact.id} (version ${artifact.version}) built from ${artifact.selected_source_count} of ${artifact.eligible_source_count} eligible sources. It is inactive until reviewed — use review_derived_artifact to approve or reject it.`,
                    {
                        artifact_id: artifact.id,
                        version: artifact.version,
                        status: "candidate" as const,
                        claims: artifact.claims,
                        validation: artifact.validation,
                        review_required: true as const,
                    },
                );
            } catch (error) {
                return artifactToolError("Self-profile rebuild", error);
            }
        },
        async updateProfile(input: unknown) {
            try {
                const { person_id, section, field, value } =
                    updateProfileInputSchema.parse(input);
                if (person_id) {
                    await deps.upsertPersonProfile(
                        person_id,
                        userId,
                        section,
                        { [field]: value },
                        env,
                    );
                    return toolStructured(
                        `Updated ${section}.${field} for person ${person_id}.`,
                        {
                            target: "person" as const,
                            id: person_id,
                            section,
                            field,
                            updated: true as const,
                        },
                    );
                }
                // Preserve neighbouring legacy self-profile fields before the
                // canonical fact write takes over the section.
                await deps.ensureLegacySelfProfileFacts(userId, env);
                await deps.setConfirmedProfileFact(
                    userId,
                    {
                        section,
                        field,
                        value,
                        verifiedAt: new Date().toISOString(),
                    },
                    env,
                );
                return toolStructured(`Updated self-profile ${section}.${field}.`, {
                    target: "self" as const,
                    id: "self",
                    section,
                    field,
                    updated: true as const,
                });
            } catch (error) {
                return artifactToolError("Profile update", error);
            }
        },
    };
}

export function registerPeopleTools(
    server: McpServer,
    env: Env,
    userId: string,
    deps: PeopleArtifactDependencies = DEFAULT_PEOPLE_ARTIFACT_DEPS,
) {
    const artifactHandlers = createPeopleArtifactHandlers(userId, env, deps);
    server.tool(
        "add_person",
        "Add a new person to the people tracker. Use this when the user mentions someone important — a friend, colleague, family member, etc. — for the first time. After adding, use update_person_profile or extract_profile_updates_from_text to populate their profile.",
        {
            name: z.string().describe("Person's full name"),
            aliases: z.array(z.string()).optional().describe("Alternative names, nicknames, or abbreviations (e.g., ['Mike', 'M.J.'])"),
        },
        async ({ name, aliases }) => {
            try {
                const person = await insertPerson(userId, name, aliases ?? [], env);
                return { content: [{ type: "text", text: `Person added: ${person.name} [${person.id}]` }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to add person: " + String(error) }] };
            }
        }
    );

    server.tool(
        "search_people",
        "Search for tracked people by name or alias. Use this to find a person's ID before updating their profile or linking them to memories.",
        {
            query: z.string().describe("Name or alias to search for (partial match supported)"),
        },
        async ({ query }) => {
            try {
                const people = await searchPeopleByName(userId, query, env);
                if (people.length === 0) {
                    return { content: [{ type: "text", text: `No people found matching "${query}".` }] };
                }
                const formatted = people.map(p => {
                    const aliases = p.aliases.length > 0 ? ` (aka: ${p.aliases.join(", ")})` : "";
                    return `[${p.id}] ${p.name}${aliases}`;
                }).join("\n");
                return { content: [{ type: "text", text: `${people.length} matches:\n${formatted}` }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to search people: " + String(error) }] };
            }
        }
    );

    server.tool(
        "list_people",
        "List all tracked people. Returns names, aliases, and IDs for every person in the system.",
        {},
        async () => {
            try {
                const people = await listPeople(userId, env);
                if (people.length === 0) {
                    return { content: [{ type: "text", text: "No people tracked yet." }] };
                }
                const formatted = people.map(p => {
                    const aliases = p.aliases.length > 0 ? ` (aka: ${p.aliases.join(", ")})` : "";
                    return `[${p.id}] ${p.name}${aliases}`;
                }).join("\n");
                return { content: [{ type: "text", text: `${people.length} people tracked:\n${formatted}` }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to list people: " + String(error) }] };
            }
        }
    );

    server.tool(
        "get_person_profile",
        "Get the full structured profile for a tracked person, including all populated sections (identity, personality, psychology, behavior, history, relationship). Use this to recall everything known about a person before discussing them.",
        { person_id: z.string().describe("Person ID (use search_people or list_people to find IDs)") },
        async ({ person_id }) => {
            try {
                const person = await getPerson(person_id, userId, env);
                if (!person) return { content: [{ type: "text", text: `Person ${person_id} not found.` }] };

                const profiles = await getPersonProfiles(person_id, userId, env);

                let text = `Profile: ${person.name}\n`;
                if (person.aliases.length > 0) text += `Aliases: ${person.aliases.join(", ")}\n`;
                text += `ID: ${person.id}\n\n`;

                if (profiles.length === 0) {
                    text += "No profile sections populated yet.";
                } else {
                    for (const p of profiles) {
                        text += `## ${p.section}\n${JSON.stringify(p.content, null, 2)}\n\n`;
                    }
                }

                return { content: [{ type: "text", text }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to get profile: " + String(error) }] };
            }
        }
    );

    server.tool(
        "update_person",
        "Update a person's name or aliases. Use this to correct misspellings, add nicknames, or update a person's name after a life change.",
        {
            person_id: z.string().describe("Person ID"),
            name: z.string().optional().describe("New name"),
            aliases: z.array(z.string()).optional().describe("Updated aliases list (replaces existing aliases)"),
        },
        async ({ person_id, name, aliases }) => {
            try {
                const person = await getPerson(person_id, userId, env);
                if (!person) return { content: [{ type: "text", text: `Person ${person_id} not found.` }] };
                await updatePerson(person_id, userId, { name, aliases }, env);
                return { content: [{ type: "text", text: `Person ${person.name} updated.${name ? ` Name → ${name}` : ""}${aliases ? ` Aliases → [${aliases.join(", ")}]` : ""}` }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to update person: " + String(error) }] };
            }
        }
    );

    server.tool(
        "delete_person",
        "Permanently delete a person and all their profile sections. This also removes their profile data but does NOT delete memories that reference them. Use with caution.",
        {
            person_id: z.string().describe("Person ID to delete"),
        },
        async ({ person_id }) => {
            try {
                const person = await getPerson(person_id, userId, env);
                if (!person) return { content: [{ type: "text", text: `Person ${person_id} not found.` }] };
                await deletePerson(person_id, userId, env);
                return { content: [{ type: "text", text: `Person ${person.name} [${person_id}] and all profile sections deleted.` }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to delete person: " + String(error) }] };
            }
        }
    );

    server.tool(
        "update_person_profile",
        "Update a specific section of a person's structured profile. Merges new key-value pairs with existing content in the section. Sections: identity, personality, psychology, behavior, history, relationship.",
        {
            person_id: z.string().describe("Person ID"),
            section: z.enum(PROFILE_SECTIONS).describe("Profile section to update"),
            content: z.record(z.unknown()).describe("Key-value pairs to merge into the section (e.g., {\"occupation\": \"engineer\", \"company\": \"Acme\"})"),
        },
        async ({ person_id, section, content }) => {
            try {
                const person = await getPerson(person_id, userId, env);
                if (!person) return { content: [{ type: "text", text: `Person ${person_id} not found.` }] };

                const existing = await getPersonProfiles(person_id, userId, env);
                const existingSection = existing.find(p => p.section === section);
                const merged = existingSection ? { ...existingSection.content, ...content } : content;

                await upsertPersonProfile(person_id, userId, section, merged, env);
                return { content: [{ type: "text", text: `Profile section '${section}' updated for ${person.name}.` }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to update profile: " + String(error) }] };
            }
        }
    );

    server.tool(
        "propose_profile_updates",
        "Stage profile updates for review before applying. Use this when you're not confident enough to apply changes directly — updates are saved as 'pending' and can be reviewed via list_pending_profile_updates, then applied or rejected.",
        {
            person_id: z.string().describe("Person ID"),
            updates: z.array(z.object({
                section: z.enum(PROFILE_SECTIONS),
                field: z.string().describe("Field name (e.g., 'occupation')"),
                value: z.string().describe("Proposed value"),
                confidence: z.number().min(0).max(1).optional().describe("How confident you are in this update"),
            })).describe("Proposed updates"),
        },
        async ({ person_id, updates }) => {
            try {
                const ids = [];
                for (const u of updates) {
                    const id = await insertPendingUpdate(userId, {
                        personId: person_id,
                        update_type: "profile_update",
                        field: `${u.section}.${u.field}`,
                        proposed_value: u.value,
                        confidence: u.confidence,
                        source: "proposed",
                    }, env);
                    ids.push(id);
                }
                return { content: [{ type: "text", text: `${updates.length} profile updates proposed (IDs: ${ids.join(", ")}). Use apply_pending_profile_updates to apply.` }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to propose updates: " + String(error) }] };
            }
        }
    );

    server.tool(
        "list_pending_profile_updates",
        "List all pending profile updates awaiting review. Each update shows the proposed field, value, and confidence score. Use apply_pending_profile_updates or reject_pending_profile_update to process them.",
        {},
        async () => {
            try {
                const updates = await listPendingUpdates(userId, env);
                if (updates.length === 0) {
                    return { content: [{ type: "text", text: "No pending profile updates." }] };
                }
                const formatted = updates.map(u =>
                    `[${u.id}] person:${u.personId ?? "self"} field:${u.field} value:"${u.proposed_value}" confidence:${u.confidence}`
                ).join("\n");
                return { content: [{ type: "text", text: `${updates.length} pending updates:\n${formatted}` }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to list pending updates: " + String(error) }] };
            }
        }
    );

    server.tool(
        "apply_pending_profile_updates",
        "Apply one or more pending profile updates, writing the proposed values into the person's profile sections.",
        {
            update_ids: z.array(z.string()).describe("IDs of pending updates to apply (from list_pending_profile_updates)"),
        },
        async ({ update_ids }) => {
            try {
                let applied = 0;
                for (const id of update_ids) {
                    const updates = await listPendingUpdates(userId, env);
                    const update = updates.find(u => u.id === id);
                    if (!update || update.status !== "pending") continue;

                    if (update.personId) {
                        const [section, field] = update.field.split(".", 2);
                        if (section && field) {
                            await upsertPersonProfile(update.personId, userId, section, { [field]: update.proposed_value }, env);
                        }
                    }
                    await setPendingUpdateStatus(id, userId, "applied", env);
                    applied++;
                }
                return { content: [{ type: "text", text: `Applied ${applied} out of ${update_ids.length} updates.` }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to apply updates: " + String(error) }] };
            }
        }
    );

    server.tool(
        "reject_pending_profile_update",
        "Reject a pending profile update, marking it as rejected without applying changes.",
        { update_id: z.string().describe("ID of the pending update to reject") },
        async ({ update_id }) => {
            try {
                await setPendingUpdateStatus(update_id, userId, "rejected", env);
                return { content: [{ type: "text", text: `Update ${update_id} rejected.` }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to reject update: " + String(error) }] };
            }
        }
    );

    server.tool(
        "extract_profile_updates_from_text",
        "Use AI to extract structured profile updates from freeform text about a person. High-confidence extractions are auto-applied; lower-confidence ones are staged as pending updates for review.",
        {
            person_id: z.string().describe("Person ID"),
            text: z.string().describe("Freeform text containing information about the person"),
            auto_apply_threshold: z.number().optional().default(0.85).describe("Confidence threshold for auto-applying (default 0.85)"),
        },
        async ({ person_id, text, auto_apply_threshold }) => {
            try {
                const person = await getPerson(person_id, userId, env);
                if (!person) return { content: [{ type: "text", text: `Person ${person_id} not found.` }] };

                const extracted = await extractProfileUpdates(text, person.name, env);
                if (extracted.length === 0) {
                    return { content: [{ type: "text", text: "No profile information extracted from text." }] };
                }

                let autoApplied = 0;
                let pendingCount = 0;

                for (const e of extracted) {
                    if (e.confidence >= auto_apply_threshold) {
                        await upsertPersonProfile(person_id, userId, e.section, { [e.field]: e.value }, env);
                        autoApplied++;
                    } else {
                        await insertPendingUpdate(userId, {
                            personId: person_id,
                            update_type: "profile_update",
                            field: `${e.section}.${e.field}`,
                            proposed_value: e.value,
                            confidence: e.confidence,
                            source: "extracted",
                        }, env);
                        pendingCount++;
                    }
                }

                return { content: [{ type: "text", text: `Extracted ${extracted.length} updates: ${autoApplied} auto-applied (confidence >= ${auto_apply_threshold}), ${pendingCount} pending review.` }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to extract profile updates: " + String(error) }] };
            }
        }
    );

    server.tool(
        "audit_profile_health",
        "Check the completeness of all person profiles. Shows which of the 6 standard sections (identity, personality, psychology, behavior, history, relationship) are populated for each person.",
        {},
        async () => {
            try {
                const people = await listPeople(userId, env);
                if (people.length === 0) {
                    return { content: [{ type: "text", text: "No people tracked." }] };
                }

                const results = [];
                for (const person of people) {
                    const profiles = await getPersonProfiles(person.id, userId, env);
                    const sections = profiles.map(p => p.section);
                    const missing = PROFILE_SECTIONS.filter(s => !sections.includes(s));
                    results.push(`${person.name}: ${sections.length}/${PROFILE_SECTIONS.length} sections (missing: ${missing.join(", ") || "none"})`);
                }

                return { content: [{ type: "text", text: `Profile Health Audit:\n${results.join("\n")}` }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to audit profiles: " + String(error) }] };
            }
        }
    );

    server.tool(
        "rebuild_profiles",
        "Rebuild all person profiles by re-extracting profile data from stored memories. Useful after bulk memory imports or to refresh stale profiles. Only applies high-confidence extractions (>= 0.7).",
        {},
        async () => {
            try {
                const people = await listPeople(userId, env);
                let rebuilt = 0;

                for (const person of people) {
                    const memories = await queryMemories(userId, env, { limit: 100, suppressed: false });
                    const personMemories = memories.filter(m =>
                        m.linked_people.includes(person.id) ||
                        m.text.toLowerCase().includes(person.name.toLowerCase())
                    );

                    if (personMemories.length > 0) {
                        const updates = await extractProfileUpdates(
                            personMemories.map(m => m.text).join("\n"),
                            person.name,
                            env
                        );
                        for (const u of updates) {
                            if (u.confidence >= 0.7) {
                                await upsertPersonProfile(person.id, userId, u.section, { [u.field]: u.value }, env);
                            }
                        }
                        rebuilt++;
                    }
                }

                return { content: [{ type: "text", text: `Rebuilt profiles for ${rebuilt} out of ${people.length} people.` }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to rebuild profiles: " + String(error) }] };
            }
        }
    );

    server.registerTool(
        "rebuild_self_profile",
        {
            description:
                "Rebuild the user's self-profile from confirmed profile facts and identity-related memories as a reviewable derived artifact. The result is an inactive candidate with claims and citations — approve it with review_derived_artifact before it enters context.",
            inputSchema: rebuildSelfProfileInputSchema,
            outputSchema: rebuildProfileOutputSchema,
        },
        artifactHandlers.rebuildSelfProfile,
    );

    server.registerTool(
        "update_profile",
        {
            description:
                "Directly set a single profile field for a person or for the user's self-profile. Self-profile writes become confirmed canonical facts. For bulk updates, use update_person_profile or extract_profile_updates_from_text instead.",
            inputSchema: updateProfileInputSchema,
            outputSchema: updateProfileOutputSchema,
        },
        artifactHandlers.updateProfile,
    );
}
