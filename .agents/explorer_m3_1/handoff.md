# Handoff Report — Prompt Intelligence Agent Context Design

## 1. Observation

During our investigation, the following files and functions were examined:

### A. Living Summary Retrieval (`src/utils/kv.ts`)
- **File path**: `src/utils/kv.ts`
- **Line numbers**: 15–17
- **Direct quote / signature**:
```typescript
export async function getLivingSummary(userId: string, env: Env): Promise<string | null> {
    return getKV(`living_summary:${userId}`, env);
}
```

### B. Database Memory Retrieval (`src/utils/db.ts`)
- **File path**: `src/utils/db.ts`
- **Line numbers**: 815–822 (`getPinnedMemories`)
- **Direct quote / signature**:
```typescript
export async function getPinnedMemories(userId: string, env: Env, limit = 50): Promise<Memory[]> {
	const res = await env.DB.prepare(
		"SELECT * FROM memories WHERE userId=? AND suppressed=0 AND pinned=1 ORDER BY salience DESC, updated_at DESC LIMIT ?",
	)
		.bind(userId, limit)
		.all();
	return (res.results as Record<string, unknown>[]).map(rowToMemory);
}
```
- **Line numbers**: 824–836 (`getHighSalienceMemories`)
- **Direct quote / signature**:
```typescript
export async function getHighSalienceMemories(
	userId: string,
	env: Env,
	minSalience = 0.7,
	limit = 25,
): Promise<Memory[]> {
	const res = await env.DB.prepare(
		"SELECT * FROM memories WHERE userId=? AND suppressed=0 AND salience>=? ORDER BY salience DESC, confidence DESC LIMIT ?",
	)
		.bind(userId, minSalience, limit)
		.all();
	return (res.results as Record<string, unknown>[]).map(rowToMemory);
}
```
- **Line numbers**: 77–82 (`getMemoryById`)
- **Direct quote / signature**:
```typescript
export async function getMemoryById(id: string, userId: string, env: Env): Promise<Memory | null> {
	const row = await env.DB.prepare("SELECT * FROM memories WHERE id=? AND userId=?")
		.bind(id, userId)
		.first();
	return row ? rowToMemory(row as Record<string, unknown>) : null;
}
```
- **Line numbers**: 778–783 (`fulltextSearchMemories`)
- **Direct quote / signature**:
```typescript
export async function fulltextSearchMemories(
	userId: string,
	query: string,
	env: Env,
	limit = 25,
): Promise<Memory[]> {
```

### C. Vector Search and Reranking (`src/utils/vectorize.ts`)
- **File path**: `src/utils/vectorize.ts`
- **Line numbers**: 42–51 (`searchMemories`)
- **Direct quote / signature**:
```typescript
export async function searchMemories(
	query: string,
	userId: string,
	env: Env,
	topK: number = 10,
	options?: {
		minScore?: number;
		filter?: VectorizeVectorMetadataFilter;
	},
): Promise<VectorMatch[]> {
```
- **Line numbers**: 88–92 (`rerankMatches`)
- **Direct quote / signature**:
```typescript
export function rerankMatches(
	query: string,
	matches: VectorMatch[],
	boosts?: Map<string, { salience?: number; confidence?: number; pinned?: boolean; access_count?: number }>,
): VectorMatch[] {
```
- **Line numbers**: 3–10 (`VectorMatch` definition)
- **Direct quote / signature**:
```typescript
export type VectorMatch = {
	id: string;
	content: string;
	score: number;
	category?: string;
	layer?: string;
	salience?: number;
};
```

---

## 2. Logic Chain

1. **Context Components Collection**:
   - The system needs to retrieve the user's `living_summary`, static profile (`self_profile`), static current context (`context_current`), and two categories of database memories: `pinned` (limit 10) and `highSalience` (default limit 25).
   - Fetching these calls in sequence creates an unnecessary serial network bottleneck. By leveraging `Promise.all`, they can be fetched in parallel.

2. **Matching Properties for Context Output**:
   - The test script `tests/prompt-engineering.test.ts` accesses retrieved memories by checking `.text`:
     `...ctx.related.slice(0, 8).map((item) => \`[\${item.id}] \${item.text}\`)`
   - However, `searchMemories` returns `VectorMatch[]`, where the text content is stored in the `.content` field.
   - Therefore, the design must resolve `VectorMatch[]` results back to complete `Memory` objects (which contain `.text`) or construct compatible objects. Resolving to complete `Memory` objects by querying D1 (`getMemoryById`) is the most reliable strategy.

3. **Optimizing D1 Database Calls**:
   - Querying `getMemoryById` serially in a `for` loop for 25 matching vectors would introduce 25 consecutive database queries.
   - Doing a parallel mapping using `Promise.all` queries the database for all matching IDs concurrently, minimizing round-trips.

4. **Robust Failure Isolation and Fallback**:
   - If the vector database or embedding generator throws an error, or if D1 query resolution fails, the system must not crash.
   - In the event of semantic search failure (or returning 0 matches), the implementation must catch the error and execute `fulltextSearchMemories(...)` as a keyword fallback. If both fail, it returns an empty array.

---

## 3. Caveats

- **Assumptions**: We assume the static context helper files (`self_profile` and `context_current`) are stored via the standard KV bindings using `readStaticFile(userId, filename, env)`.
- **Reranking Bounds**: We assume that since `rerankMatches` takes a list of `VectorMatch` and returns a list of `VectorMatch`, we should filter and rank matches as vectors, and only resolve the top 8 matches into D1 `Memory` records to avoid bloated fetches.

---

## 4. Conclusion

We have designed a robust, fast context builder function `buildAgentContext` inside `src/utils/agents.ts` that coordinates KV, R2/KV static files, D1 database retrieval, and semantic search.

### Exact Proposed Implementation for `src/utils/agents.ts`

```typescript
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

/**
 * Builds context pack for a user/query. Coordinates KV summary, D1 records, and semantic search.
 * Includes a robust fallback to keyword fulltext search if semantic search throws an error or yields no matches.
 */
export async function buildAgentContext(
	userId: string,
	query: string,
	env: Env
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
				vectorMatches.map((m) => getMemoryById(m.id, userId, env).catch(() => null))
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
```

---

## 5. Verification Method

### Local Verification
1. Inspect the implementation of `buildAgentContext` inside `src/utils/agents.ts` to ensure type compatibility with `Memory` (from `src/types.ts`) and functions imported from `kv.ts`, `db.ts`, and `vectorize.ts`.
2. To test locally:
   ```bash
   npm run test:all
   ```
3. An independent unit test suite in `tests/prompt-engineering.test.ts` can mock the database inputs and confirm that when semantic search fails, the fallback search is correctly invoked.
