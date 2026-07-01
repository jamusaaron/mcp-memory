import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { insertPerson, listPeople, getPerson, getPersonProfiles, upsertPersonProfile, insertPendingUpdate, listPendingUpdates, setPendingUpdateStatus, queryMemories } from "../utils/db";
import { extractProfileUpdates, generateSummary } from "../utils/ai";
import { writeStaticFile } from "../utils/r2";
import { PROFILE_SECTIONS } from "../types";

export function registerPeopleTools(server: McpServer, env: Env, userId: string) {
    server.tool(
        "add_person",
        "Add a new person to the people tracker.",
        {
            name: z.string().describe("Person's name"),
            aliases: z.array(z.string()).optional().describe("Alternative names or nicknames"),
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
        "list_people",
        "List all tracked people.",
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
        "Get the full structured profile for a tracked person.",
        { person_id: z.string().describe("Person ID") },
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
        "update_person_profile",
        "Update a specific section of a person's profile.",
        {
            person_id: z.string().describe("Person ID"),
            section: z.enum(PROFILE_SECTIONS).describe("Profile section"),
            content: z.record(z.unknown()).describe("Section content as key-value pairs"),
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
        "Propose updates to a person's profile for review before applying.",
        {
            person_id: z.string().describe("Person ID"),
            updates: z.array(z.object({
                section: z.enum(PROFILE_SECTIONS),
                field: z.string(),
                value: z.string(),
                confidence: z.number().min(0).max(1).optional(),
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
        "List all pending profile updates awaiting review.",
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
        "Apply pending profile updates. Updates with confidence above threshold are auto-applied; others require this explicit call.",
        {
            update_ids: z.array(z.string()).describe("IDs of pending updates to apply"),
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
        "Reject a pending profile update.",
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
        "Use AI to extract structured profile updates from freeform text about a person.",
        {
            person_id: z.string().describe("Person ID"),
            text: z.string().describe("Text containing information about the person"),
            auto_apply_threshold: z.number().optional().default(0.85).describe("Auto-apply updates above this confidence"),
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

                return { content: [{ type: "text", text: `Extracted ${extracted.length} updates: ${autoApplied} auto-applied (confidence ≥ ${auto_apply_threshold}), ${pendingCount} pending review.` }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to extract profile updates: " + String(error) }] };
            }
        }
    );

    server.tool(
        "audit_profile_health",
        "Check the health and completeness of all person profiles.",
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
        "Rebuild all person profiles from stored memories. Re-aggregates profile sections from memory data.",
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

    server.tool(
        "rebuild_self_profile",
        "Rebuild the user's self-profile from all stored memories and save to R2.",
        {},
        async () => {
            try {
                const memories = await queryMemories(userId, env, { limit: 200, suppressed: false });
                const identityMemories = memories.filter(m =>
                    ["identity", "preferences", "likes", "goals", "rules"].includes(m.category)
                );

                if (identityMemories.length === 0) {
                    return { content: [{ type: "text", text: "No identity-related memories found to build self-profile." }] };
                }

                const summary = await generateSummary(identityMemories.map(m => ({
                    text: m.text, category: m.category,
                })), env);

                await writeStaticFile(userId, "self_profile", summary, env);

                return { content: [{ type: "text", text: `Self-profile rebuilt from ${identityMemories.length} memories and saved.` }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to rebuild self-profile: " + String(error) }] };
            }
        }
    );

    server.tool(
        "update_profile",
        "Directly update a profile field for a person or self.",
        {
            person_id: z.string().optional().describe("Person ID (omit for self-profile)"),
            section: z.enum(PROFILE_SECTIONS).describe("Profile section"),
            field: z.string().describe("Field name"),
            value: z.string().describe("Field value"),
        },
        async ({ person_id, section, field, value }) => {
            try {
                if (person_id) {
                    await upsertPersonProfile(person_id, userId, section, { [field]: value }, env);
                    return { content: [{ type: "text", text: `Updated ${section}.${field} for person ${person_id}.` }] };
                }
                const selfProfiles = await getPersonProfiles("self", userId, env);
                const existing = selfProfiles.find(p => p.section === section);
                const merged = existing ? { ...existing.content, [field]: value } : { [field]: value };
                await upsertPersonProfile("self", userId, section, merged, env);
                return { content: [{ type: "text", text: `Updated self-profile ${section}.${field}.` }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to update profile: " + String(error) }] };
            }
        }
    );
}
