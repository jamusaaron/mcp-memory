import { getLivingSummary } from "./kv";
import { getPinnedMemories, getHighSalienceMemories, getMemoryById, fulltextSearchMemories } from "./db";
import { searchMemories, rerankMatches } from "./vectorize";
import { readStaticFile } from "./static-context";
import type { Memory } from "../types";

export interface AgentContextPack {
	summary: string | null;
	selfProfile: string | null;
	contextCurrent: string | null;
	pinned: Memory[];
	related: Memory[];
	highSalience: Memory[];
	memoryIds: string[];
}

export function getPromptSystemContract(): string {
	return "You are a specialized prompt engineering agent. Follow modern durable principles: structured output, adaptive thinking/effort control, source material before query.";
}

/**
 * Builds context pack for a user/query. Coordinates KV summary, D1 records, and semantic search.
 * Includes a robust fallback to keyword fulltext search if semantic search throws an error or yields no matches.
 */
export async function buildAgentContext(
	userId: string,
	query: string,
	env: Env,
): Promise<AgentContextPack> {
	// 1. Parallel fetch of living summary, profiles, and initial database records
	const [summary, selfProfile, contextCurrent, pinned, highSalience] = await Promise.all([
		getLivingSummary(userId, env).catch((err) => {
			console.error("[buildAgentContext] Failed to fetch living summary:", err);
			return null;
		}),
		readStaticFile(userId, "self_profile", env).catch((err) => {
			console.error("[buildAgentContext] Failed to fetch self profile:", err);
			return null;
		}),
		readStaticFile(userId, "context_current", env).catch((err) => {
			console.error("[buildAgentContext] Failed to fetch current context:", err);
			return null;
		}),
		getPinnedMemories(userId, env, 10).catch((err) => {
			console.error("[buildAgentContext] Failed to fetch pinned memories:", err);
			return [];
		}),
		getHighSalienceMemories(userId, env, 0.7, 25).catch((err) => {
			console.error("[buildAgentContext] Failed to fetch high-salience memories:", err);
			return [];
		}),
	]);

	// 2. Resolve related memories using hybrid search & reranking
	let related: Memory[] = [];
	try {
		// Over-fetch vector matches for reranking
		const vectorMatches = await searchMemories(query, userId, env, 25);

		if (vectorMatches && vectorMatches.length > 0) {
			const boosts = new Map<
				string,
				{ salience?: number; confidence?: number; pinned?: boolean; access_count?: number }
			>();
			const memMap = new Map<string, Memory>();

			// Concurrently retrieve Memory objects for the matching vector IDs
			const mems = await Promise.all(
				vectorMatches.map((m) => getMemoryById(m.id, userId, env).catch(() => null)),
			);

			for (let i = 0; i < vectorMatches.length; i++) {
				const match = vectorMatches[i];
				const mem = mems[i];
				if (mem && !mem.suppressed) {
					memMap.set(match.id, mem);
					boosts.set(match.id, {
						salience: mem.salience,
						confidence: mem.confidence,
						pinned: mem.pinned,
						access_count: mem.access_count,
					});
				}
			}

			// Perform reranking on valid vector matches
			const validMatches = vectorMatches.filter((m) => memMap.has(m.id));
			const rankedMatches = rerankMatches(query, validMatches, boosts);

			// Map back to Memory object structures
			related = rankedMatches.map((m) => memMap.get(m.id)!).slice(0, 8);
		}

		// Fallback to keyword-based search if semantic search succeeded but returned nothing
		if (related.length === 0) {
			related = await fulltextSearchMemories(userId, query, env, 8).catch(() => []);
		}
	} catch (error) {
		console.error("[buildAgentContext] Semantic search failed. Falling back to keyword search:", error);
		try {
			related = await fulltextSearchMemories(userId, query, env, 8);
		} catch (fallbackError) {
			console.error("[buildAgentContext] Keyword search fallback failed:", fallbackError);
			related = [];
		}
	}

	// 3. Compile the unique memory IDs retrieved in this context pack
	const memoryIdsSet = new Set<string>();
	pinned.forEach((m) => memoryIdsSet.add(m.id));
	highSalience.forEach((m) => memoryIdsSet.add(m.id));
	related.forEach((m) => memoryIdsSet.add(m.id));

	return {
		summary,
		selfProfile,
		contextCurrent,
		pinned,
		related,
		highSalience,
		memoryIds: Array.from(memoryIdsSet),
	};
}
