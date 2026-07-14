# Handoff Report — Explorer M2 (Policy & Validators)

## 1. Observation

A systematic codebase search and inspection was performed to verify the existence, signatures, and locations of the helper imports needed for Task 1 of the Prompt Intelligence implementation:

1. **`src/utils/ai.ts`**:
   - Verification via `view_file` showed that `src/utils/ai.ts` consists of `llmCall`, `triageText`, `extractProfileUpdates`, `detectContradictions`, `generateSummary`, `analyzePatterns`, and `extractFromTranscript`.
   - The functions `extractJsonObject` and `llmCallSystem` are **missing** from this file.
   - Grep search for `extractJsonObject` returned no results in code files:
     ```json
     {"File":"docs/superpowers/plans/2026-07-12-prompt-intelligence.md","LineNumber":128,"LineContent":"import { extractJsonObject, llmCallSystem } from \"./ai\";"}
     ```
   - Grep search for `llmCallSystem` returned no results in code files.

2. **`src/utils/agents.ts`**:
   - Finding by name `agents*` in `src/` directory returned 0 results.
   - The file `src/utils/agents.ts` **does not exist**.
   - Consequently, `buildAgentContext` is **missing**.

3. **`src/utils/db.ts`**:
   - Verification via `view_file` of `src/utils/db.ts` showed CRUD operations for `memories`, `people`, `person_profiles`, `pending_updates`, `session_logs`, `uncertainties`, `ai_notes`, `transcripts`, `behavioral_observations`, `personality_feedback`, and `getWriteActivity`.
   - The function `insertAgentRun` is **missing** from this file.
   - Grep search for `insertAgentRun` returned no results in code files.

4. **`src/schema.ts`**:
   - Verification via `view_file` of `src/schema.ts` showed `MIGRATIONS` defining tables for `memories`, `people`, `person_profiles`, `pending_updates`, `session_logs`, `uncertainties`, `ai_notes`, `transcripts`, `behavioral_observations`, and `personality_feedback`.
   - No `agent_runs` table exists in the schema.

---

## 2. Logic Chain

1. **Helper Imports**: Since `extractJsonObject`, `llmCallSystem`, `buildAgentContext`, and `insertAgentRun` are required imports for the prompt engineering utils, they must be implemented before or during Task 1.
2. **Missing Table**: The design spec states that prompt runs are logged through `insertAgentRun` to the `agent_runs` table. Since this table does not exist in `src/schema.ts`, a database schema definition and migration is needed.
3. **Context Retrieval**: `buildAgentContext` must pull the cached living summary from Cloudflare KV (using `getLivingSummary` from `src/utils/kv.ts`), retrieve pinned and high salience memories from D1 (using `getPinnedMemories` and `getHighSalienceMemories` from `src/utils/db.ts`), and semantically fetch query-related memories (using `searchMemories` and `rerankMatches` from `src/utils/vectorize.ts`).

---

## 3. Caveats

- **No D1 Migrations**: The plan notes: "Add no D1 migration...". This implies that we should not create new D1 migration files under a migration directory. Instead, the project initializes D1 schemas dynamically using the `MIGRATIONS` array inside `src/schema.ts` when starting the worker.
- **Workers AI Model**: `llmCallSystem` must call the same model as the rest of the application (`@cf/meta/llama-3.1-8b-instruct`).

---

## 4. Conclusion

To successfully implement Task 1 and Task 2, we must define the missing helpers and schema tables. Below is the precise implementation strategy.

### Proposed Code for Missing Helpers

#### 1. Add `extractJsonObject` and `llmCallSystem` to `src/utils/ai.ts`
```typescript
/**
 * Utility to extract the first JSON object from a string and parse it.
 */
export function extractJsonObject<T>(text: string): T | null {
    try {
        const match = text.match(/\{[\s\S]*\}/);
        if (match) {
            return JSON.parse(match[0]) as T;
        }
    } catch {
        // Fall through on JSON parsing failure
    }
    return null;
}

/**
 * Perform a Workers AI chat call with a system prompt and a user prompt.
 */
export async function llmCallSystem(system: string, user: string, env: Env, maxTokens = 2200): Promise<string> {
    const result = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
        messages: [
            { role: "system", content: system },
            { role: "user", content: user }
        ],
        max_tokens: maxTokens,
    }) as { response?: string };
    return result.response ?? "";
}
```

#### 2. Create `src/utils/agents.ts`
This module will define `buildAgentContext` and its interfaces.
```typescript
import { getLivingSummary } from "./kv";
import { getPinnedMemories, getHighSalienceMemories, getMemoryById } from "./db";
import { searchMemories, rerankMatches } from "./vectorize";
import type { Memory } from "../types";

export interface AgentContextPack {
	summary: string;
	selfProfile: null;
	contextCurrent: null;
	pinned: Memory[];
	related: Memory[];
	highSalience: Memory[];
	memoryIds: string[];
}

export async function buildAgentContext(
	userId: string,
	query: string,
	env: Env,
): Promise<AgentContextPack> {
	const summary = (await getLivingSummary(userId, env)) ?? "";
	const pinned = await getPinnedMemories(userId, env);
	const highSalience = await getHighSalienceMemories(userId, env);

	let related: Memory[] = [];
	try {
		const matches = await searchMemories(query, userId, env, 15);
		const boosts = new Map<string, { salience?: number; confidence?: number; pinned?: boolean; access_count?: number }>();
		const resolved: Memory[] = [];
		for (const m of matches) {
			const mem = await getMemoryById(m.id, userId, env);
			if (mem && !mem.suppressed) {
				boosts.set(m.id, {
					salience: mem.salience,
					confidence: mem.confidence,
					pinned: mem.pinned,
					access_count: mem.access_count,
				});
				resolved.push(mem);
			}
		}
		const reranked = rerankMatches(query, resolved.map(m => ({
			id: m.id,
			content: m.text,
			score: 0.5,
			salience: m.salience,
		})), boosts);
		
		related = reranked.map(r => resolved.find(m => m.id === r.id)).filter(Boolean) as Memory[];
	} catch (error) {
		console.error("buildAgentContext: semantic search failed:", error);
	}

	const memoryIds = Array.from(new Set([
		...pinned.map(m => m.id),
		...highSalience.map(m => m.id),
		...related.map(m => m.id),
	]));

	return {
		summary,
		selfProfile: null,
		contextCurrent: null,
		pinned,
		related,
		highSalience,
		memoryIds,
	};
}
```

#### 3. Update `src/schema.ts`
Add the `agent_runs` table definition and index inside the `MIGRATIONS` array:
```typescript
    `CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        role TEXT NOT NULL,
        input TEXT NOT NULL,
        output TEXT NOT NULL,
        memory_ids TEXT DEFAULT '[]',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_agent_runs_user ON agent_runs(userId)`,
```

#### 4. Add `insertAgentRun` to `src/utils/db.ts`
```typescript
export async function insertAgentRun(
	userId: string,
	role: string,
	input: string,
	output: string,
	memoryIds: string[],
	env: Env,
): Promise<string> {
	const id = uuidv4();
	await env.DB.prepare(
		`INSERT INTO agent_runs (id, userId, role, input, output, memory_ids)
		 VALUES (?, ?, ?, ?, ?, ?)`
	)
		.bind(id, userId, role, input, output, JSON.stringify(memoryIds))
		.run();
	return id;
}
```

---

### Implementation Plan for Policy, Validators, and Unit Tests

#### A. Creating `src/utils/prompt-engineering.ts`
- Implement pure configurations (`PROMPT_POLICY`, `CLAUDE_POLICY`).
- Implement pure validation functions:
  - `policyForTarget(target: PromptTarget): string`
  - `missingSections(output: string, required: string[]): string[]`
  - `parsePromptEvaluation(text: string): PromptEvaluation`
- Implement the async orchestration routines:
  - `buildPrompt(userId, request, env, deps)`
  - `improvePrompt(userId, request, env, deps)`
  - `evaluatePrompt(userId, prompt, target, intendedOutcome, env, deps)`
- Support `PromptRuntimeDependencies` parameter allowing mocks to be injected for `buildContext`, `callModel`, and `logRun` dependencies.

#### B. Creating `tests/prompt-engineering.test.ts`
The tests should be structured using Node's native runner:
1. **Pure Policy Tests**: Confirm `PROMPT_POLICY` includes/excludes key guidelines (e.g. adaptive thinking, source ordering, and lacks prefill recommendations/chaining bans).
2. **Target Routing Tests**: Verify target routing for `Claude` appends `CLAUDE_POLICY`.
3. **Parser Tests**:
   - Assert `missingSections` correctly identifies missing markdown headings.
   - Assert `parsePromptEvaluation` correctly parses valid JSON, clamps scores to `0..100`, and throws on invalid inputs.
4. **Mocked Integration / Orchestration Tests**:
   - Verify `useMemory: true` calls `buildContext` and formats matching memory IDs.
   - Verify `useMemory: false` bypasses memory context retrieval entirely.
   - Verify repair mechanics: `buildPrompt` and `improvePrompt` perform at most 1 repair call on missing headers.
   - Verify `evaluatePrompt` performs at most 1 repair call on malformed JSON / score violations.

---

## 5. Verification Method

To verify these changes:
1. **Compilation Check**: Verify TypeScript compiling succeeds:
   ```bash
   npx tsc --noEmit
   ```
2. **Execute Tests**: Run the prompt engineering tests:
   ```bash
   node --import tsx --test tests/prompt-engineering.test.ts
   ```
3. **Check Test Exit Status**: Ensure tests pass with exit code `0`.
