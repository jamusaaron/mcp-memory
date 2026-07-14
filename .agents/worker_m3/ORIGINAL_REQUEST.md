## 2026-07-12T12:07:16Z
You are a Worker for M3 (Orchestration Runtime) in the Prompt Intelligence project.
Your working directory is: /Users/jamieyoung/.gemini/antigravity/worktrees/mcp-memory/teamwork-preview-feature-enhancements/.agents/worker_m3

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A Forensic Auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Your task:
Implement the complete Orchestration Runtime (Milestone 3) and resolve the code quality issues from M2.

1. **Helper Modifications**:
   - In `src/utils/ai.ts`, add the non-greedy `extractJsonObject` function (to extract first JSON block safely) and `llmCallSystem` (system prompt + user prompt Workers AI chat runner):
     ```typescript
     export function extractJsonObject<T>(text: string): T | null {
         try {
             const startIdx = text.indexOf('{');
             if (startIdx !== -1) {
                 const substring = text.substring(startIdx);
                 const match = substring.match(/^\{[\s\S]*?\}/);
                 return JSON.parse(substring) as T;
             }
         } catch {}
         try {
             const match = text.match(/\{[\s\S]*?\}/);
             if (match) return JSON.parse(match[0]) as T;
         } catch {}
         return null;
     }

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
   
   - In `src/types.ts`, export the `AgentRun` interface:
     ```typescript
     export interface AgentRun {
         id: string;
         userId: string;
         role: string;
         input: string;
         output: string;
         memory_ids: string[];
         created_at: string;
     }
     ```

   - In `src/schema.ts`, add the `agent_runs` table schema definition and index to the end of the `MIGRATIONS` array:
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

   - In `src/utils/db.ts`, import `AgentRun` from `../types` and add the `insertAgentRun` database helper function:
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
             "INSERT INTO agent_runs (id,userId,role,input,output,memory_ids) VALUES (?,?,?,?,?,?)",
         )
             .bind(id, userId, role, input, output, JSON.stringify(memoryIds || []))
             .run();
         return id;
     }
     ```

2. **Agent Context Builder**:
   - Create `src/utils/agents.ts`. Implement `buildAgentContext` using parallel promise fetches, semantic search with fallback to full-text search, and unique ID collection. Refer to the design report in `.agents/explorer_m3_1/handoff.md`.

3. **Orchestration Runtime in `src/utils/prompt-engineering.ts`**:
   - Update `missingSections` to escape regex characters in section headings.
   - Update `parsePromptEvaluation` to check for `Number.isNaN` to reject NaN scores, and map both camelCase/snake_case recommended changes.
   - Implement `PromptRuntimeDependencies` and its default implementations (`DEFAULT_DEPS`).
   - Implement the actual runtime orchestration functions `buildPrompt`, `improvePrompt`, and `evaluatePrompt` using `generateSections` and `optionalContext` helpers as specified in Task 2.

4. **Expand Unit Tests in `tests/prompt-engineering.test.ts`**:
   - Implement the `StatefulPromptTestHarness` class and add unit tests to verify:
     - Repair logic ceiling (exactly one retry and throws on second failure).
     - Memory formatting boundary conditions and error resilience (handling DB failures gracefully).
     - Key format normalizations (camelCase/snake_case recommended changes, NaN score detection triggering repair).

5. **Verify**:
   - Run unit tests: `node --import tsx --test tests/prompt-engineering.test.ts`
   - Run type-checks: `npx tsc --noEmit`
   - Ensure all other existing tests pass: `npm test`
   - Output your results to `.agents/worker_m3/handoff.md` and notify me.
