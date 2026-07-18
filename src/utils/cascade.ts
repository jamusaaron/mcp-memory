// Write cascade: keeps derived documents (living summary, self-profile) in
// sync with the raw memory store without forcing an AI call on every write.
//
// Each memory write bumps a cheap dirty counter (no AI call). The counter is
// checked on every write and cleared to zero on rebuild:
//   - write_memory / batch_write_memories: auto-rebuilds once the counter
//     crosses a threshold, so long-running sessions stay roughly current.
//   - session_close: always rebuilds if the counter is non-zero, since a
//     session boundary is a natural, infrequent point where the AI cost is
//     worth paying regardless of how small the change was.
// All rebuild calls are best-effort — a failure here never fails the memory
// write or session close that triggered it.

import { queryMemories } from "./db";
import { generateSummary } from "./ai";
import { getKV, putKV, putLivingSummary } from "./kv";
import { writeStaticFile } from "./r2";
import type { Category } from "../types";

const LIVING_SUMMARY_REBUILD_THRESHOLD = 10;
const SELF_PROFILE_REBUILD_THRESHOLD = 5;
const SELF_PROFILE_CATEGORIES: Category[] = ["identity", "preferences", "likes", "goals", "rules"];

function dirtyKey(kind: "living_summary" | "self_profile", userId: string): string {
    return `${kind}_dirty:${userId}`;
}

async function getDirtyCount(kind: "living_summary" | "self_profile", userId: string, env: Env): Promise<number> {
    const raw = await getKV(dirtyKey(kind, userId), env);
    return raw ? (parseInt(raw, 10) || 0) : 0;
}

async function bumpDirtyCount(kind: "living_summary" | "self_profile", userId: string, env: Env, by: number): Promise<void> {
    if (by <= 0) return;
    const current = await getDirtyCount(kind, userId, env);
    await putKV(dirtyKey(kind, userId), String(current + by), env);
}

async function clearDirtyCount(kind: "living_summary" | "self_profile", userId: string, env: Env): Promise<void> {
    await putKV(dirtyKey(kind, userId), "0", env);
}

/**
 * Record that `count` memories were written, optionally with their
 * categories (used to decide whether the self-profile is affected too).
 * Cheap — no AI call, safe to call on every write_memory/batch write.
 */
export async function markMemoriesWritten(userId: string, env: Env, categories: string[]): Promise<void> {
    try {
        await bumpDirtyCount("living_summary", userId, env, categories.length);
        const selfProfileHits = categories.filter(c => SELF_PROFILE_CATEGORIES.includes(c as Category)).length;
        await bumpDirtyCount("self_profile", userId, env, selfProfileHits);
    } catch (e) {
        console.error("Cascade: failed to mark dirty count:", e);
    }
}

export async function rebuildLivingSummaryNow(userId: string, env: Env): Promise<string | null> {
    const memories = await queryMemories(userId, env, { limit: 200, suppressed: false });
    if (memories.length === 0) return null;
    const summary = await generateSummary(memories.map(m => ({ text: m.text, category: m.category })), env);
    await putLivingSummary(userId, summary, env);
    await clearDirtyCount("living_summary", userId, env);
    return summary;
}

export async function rebuildSelfProfileNow(userId: string, env: Env): Promise<string | null> {
    const memories = await queryMemories(userId, env, { limit: 200, suppressed: false });
    const identityMemories = memories.filter(m => SELF_PROFILE_CATEGORIES.includes(m.category as Category));
    if (identityMemories.length === 0) return null;
    const summary = await generateSummary(identityMemories.map(m => ({ text: m.text, category: m.category })), env);
    await writeStaticFile(userId, "self_profile", summary, env);
    await clearDirtyCount("self_profile", userId, env);
    return summary;
}

/**
 * Called from write_memory / batch_write_memories after a successful insert.
 * Rebuilds only once enough writes have accumulated, so a burst of writes
 * pays the AI cost once instead of on every call. Never throws.
 */
export async function autoRebuildIfDirty(userId: string, env: Env): Promise<void> {
    try {
        if ((await getDirtyCount("living_summary", userId, env)) >= LIVING_SUMMARY_REBUILD_THRESHOLD) {
            await rebuildLivingSummaryNow(userId, env);
        }
    } catch (e) {
        console.error("Cascade: auto-rebuild of living summary skipped:", e);
    }

    try {
        if ((await getDirtyCount("self_profile", userId, env)) >= SELF_PROFILE_REBUILD_THRESHOLD) {
            await rebuildSelfProfileNow(userId, env);
        }
    } catch (e) {
        console.error("Cascade: auto-rebuild of self-profile skipped:", e);
    }
}

/**
 * Called from session_close. Unlike autoRebuildIfDirty, this rebuilds on any
 * non-zero dirty count — a session boundary is infrequent enough that the AI
 * cost is worth paying even for a single new memory. Never throws.
 */
export async function rebuildDirtyOnSessionClose(userId: string, env: Env): Promise<{ livingSummary: boolean; selfProfile: boolean }> {
    let livingSummary = false;
    let selfProfile = false;

    try {
        if ((await getDirtyCount("living_summary", userId, env)) > 0) {
            livingSummary = (await rebuildLivingSummaryNow(userId, env)) !== null;
        }
    } catch (e) {
        console.error("Cascade: session-close rebuild of living summary skipped:", e);
    }

    try {
        if ((await getDirtyCount("self_profile", userId, env)) > 0) {
            selfProfile = (await rebuildSelfProfileNow(userId, env)) !== null;
        }
    } catch (e) {
        console.error("Cascade: session-close rebuild of self-profile skipped:", e);
    }

    return { livingSummary, selfProfile };
}

/** Read-only staleness check for get_session_brief — no writes, no AI calls. */
export async function getStaleness(userId: string, env: Env): Promise<{ livingSummaryDirty: number; selfProfileDirty: number }> {
    return {
        livingSummaryDirty: await getDirtyCount("living_summary", userId, env),
        selfProfileDirty: await getDirtyCount("self_profile", userId, env),
    };
}
