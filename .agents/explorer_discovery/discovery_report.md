# MCP Memory Prompt Intelligence Discovery Report

**Date:** 12 July 2026  
**Agent:** explorer_discovery (Archetype: Explorer)  
**Workspace:** `/Users/jamieyoung/.gemini/antigravity/worktrees/mcp-memory/teamwork-preview-feature-enhancements`

---

## Executive Summary
This report analyzes the existing `mcp-memory` codebase structure, tool registration mechanism, tool surface check assertions, and database storage patterns to formulate design specifications and implementation recommendations for the upcoming **Prompt Intelligence** feature. 

This enhancement will add three memory-aware prompt engineering tools (`prompt_build`, `prompt_improve`, `prompt_evaluate`) and a reusable `prompt` agent role. The implementation will reuse existing memory search pipelines (hybrid vectorized and full-text) and KV caching, and it requires no new migrations or bindings.

---

## 1. Existing MCP Tool Registration & Structure

### Registration Mechanism (`src/mcp.ts`)
- **Framework:** The codebase utilizes `@modelcontextprotocol/sdk/server/mcp.js` (`McpServer`) for the Model Context Protocol server.
- **Server Mount:** The server is initialized in `MyMCP` (extending `McpAgent` from the `agents/mcp` library). It mounts under `src/index.ts` using Server-Sent Events (SSE) at `/:userId/sse` via `MyMCP.mount(...)`.
- **Tool Initialization:** Within the `init()` method of `MyMCP`, tool registration functions are imported from `src/tools/` and called sequentially (passing `this.server`, `env`, and the current session's `userId`):
  ```ts
  registerMemoryTools(this.server, env, userId);
  registerPeopleTools(this.server, env, userId);
  ...
  registerHealthTools(this.server, env, userId);
  registerInfraTools(this.server, env);
  ```

### Tool Structure (`src/tools/`)
Each file under `src/tools/` exports a registration function mapping Zod-validated input properties to handler logic:
- Input parameters are validated via `z.object({...})` schemas.
- Output text is wrapped in helper functions `toolText(text)` or `toolError(error)` (imported from `../utils/tool-result`), returning a standard MCP content block.
- Examples of current tool modules:
  - `src/tools/memory.ts`: CRUD operations on user memory, pattern analysis, living summary regeneration, contradiction detection.
  - `src/tools/ai-agents.ts`: Cross-agent communication logs (`ai_note_write`, `ai_note_read`, `ai_notes_cross_check`).
  - `src/tools/session.ts`: Session state loading, intent recording, and audit logging.

---

## 2. Expected Tool Surface Checks (`scripts/check-tool-surface.mjs`)

The `scripts/check-tool-surface.mjs` script acts as a release gate to prevent registration pollution or accidental dependency exposures:
- **Registry Count:** Asserts that the total number of registered tools equals `EXPECTED_TOOLS` (currently set to `110`).
- **File Matching:** Scans the `activeFiles` list (including `src/tools/*.ts` files) for instances of `server.tool("...")` to collect tool names.
- **Forbidden Tools:** Verifies that no legacy or static files tools (e.g. `read_static_file`, `r2_bucket_create`) are present.
- **R2 Check:** Restricts all R2 operations. Scans source files to ensure no R2 dependencies (like `utils/r2` or `R2_BUCKET`) remain, and validates that `wrangler.jsonc` does not define R2 buckets.
- **Limiter Enforcements:** Asserts `RATE_LIMITER.limit` is present in the main index handler.
- **Documentation Verification:** Validates that `CLAUDE.md` and `README.md` represent correct dependency bindings and configs.

---

## 3. Agent Roles Configuration

- **Current State:** The codebase currently handles agents using the `agents` package dependency (`agents: "0.7.0"`). It does not contain an existing local role configurations file `src/utils/agents.ts` or `src/types.ts` `AGENT_ROLES` array. These will be added as part of the implementation.
- **Design Specifications:**
  - `src/types.ts`: Define a new exported `AGENT_ROLES` string array containing `"prompt"` (positioned before `"general"`).
  - `src/utils/agents.ts`: Define `ROLE_SYSTEM` representing agent system prompts and export `buildAgentContext`. The prompt role contract should state:
    > "You are a memory-aware prompt engineer. Preserve the user's objective and hard constraints, use relevant memory only as labelled context, adapt to the named target tool, expose assumptions, prefer native structured output, bound agentic authority, and avoid obsolete model folklore. Return a paste-ready prompt before concise configuration notes. Australian English."

---

## 4. Memory Formatting, Retrieval, and Storage Usage

### Memory Data Structure (`src/types.ts`)
A `Memory` is structured with properties:
- `id`, `userId`, `category` (one of 14 categories), `layer` (core, long_embedded, mid_ground, current).
- `text` (primary string), `subject`, `tags` (JSON string array), `triggers` (JSON string array).
- `confidence`, `salience`, `emotion_weight`, `source_type`.
- `suppressed` (boolean), `pinned` (boolean), `access_count`, and audit timestamps.

### Retrieval Pipeline (`src/utils/vectorize.ts` and `src/utils/db.ts`)
1. **Vector Search:** Queries Cloudflare Vectorize namespaces by `userId` using embeddings generated via the `@cf/baai/bge-m3` model. Similarity scores below 0.4 are excluded.
2. **Full-Text Search:** Tokenizes queries and checks using SQL `LIKE` conditions against memory `text`, `subject`, and `tags`.
3. **Blended Reranking (`rerankMatches`):** Combines the cosine similarity score (70% weight) with keyword token overlap (15%), salience (15%), confidence (10%), pinning (12% flat boost), and historical access count (up to 8% boost) to produce a hybrid ranked output.

### D1 Database vs. KV Cache Usage
- **D1 SQL Database (`env.DB`):** Holds relational tables for `memories`, `people`, `person_profiles`, `pending_updates`, `session_logs`, `uncertainties`, `transcripts`, `behavioral_observations`, and `personality_feedback`.
- **KV Storage (`env.KV`):** Stores high-read living summaries (`living_summary:${userId}`), behavioral caches, personality profiles, and active session states (`session:${userId}:${sessionId}`) to bypass D1 read limits.

---

## 5. Architectural Recommendations for Prompt Intelligence

To support the three tools (`prompt_build`, `prompt_improve`, `prompt_evaluate`) and the `prompt` role, we propose the following module design, execution flows, and implementation milestones.

### Proposed Architecture

1. **`src/utils/prompt-engineering.ts` (Pure Policy & Runtime Orchestrator):**
   - **`PROMPT_POLICY`:** Defines modern, durable guiding principles (e.g., XML delimiters, putting source context before query, avoiding Claude prefilling for 4.6+, preferring native JSON schemas, enabling adaptive thinking, avoiding blanket chaining bans).
   - **`policyForTarget(target: PromptTarget)`:** Appends specific Anthropic guidance if the target tool or model mentions Claude/Anthropic.
   - **`buildPrompt` / `improvePrompt` / `evaluatePrompt`:** orchestrates dependency-injected routines. Exposes a `PromptRuntimeDependencies` interface to mock KV/D1/LLM calls during unit tests.
   
2. **`src/tools/prompt-engineering.ts` (MCP Layer):**
   - Defines Zod validation schemas for input arguments.
   - Registers `prompt_build`, `prompt_improve`, and `prompt_evaluate` with `McpServer`.
   
3. **`tests/prompt-engineering.test.ts` (Unit / Contract Tests):**
   - Assures correctness of pure logic (policy rendering, section existence, evaluation JSON parsing, score clamp ranges `0..100`).
   - Assures that model response failures or schema violations attempt exactly one repair call.

### Interface Contracts

```ts
// src/utils/prompt-engineering.ts

export type PromptTarget = {
	tool: string;
	model?: string;
	mode?: "chat" | "api" | "agent" | "ide" | "image" | "video" | "voice" | "workflow";
};

export type PromptBuildRequest = {
	objective: string;
	target: PromptTarget;
	outputRequirements?: string;
	constraints?: string[];
	inputDescription?: string;
	useMemory: boolean;
};

export type PromptImprovementRequest = {
	prompt: string;
	target: PromptTarget;
	knownFailure?: string;
	preserve?: string[];
	useMemory: boolean;
};

export type PromptEvaluation = {
	scores: Record<"clarity" | "grounding" | "scope" | "output_contract" | "tool_fit" | "token_efficiency" | "safety", number>;
	strengths: string[];
	risks: string[];
	recommendedChanges: string[];
	verdict: "ready" | "revise" | "insufficient_context";
};

export type PromptOperationResult = {
	output: string;
	runId: string;
	memoryIds: string[];
	memoryAvailable: boolean;
};

export type PromptRuntimeDependencies = {
	buildContext: (userId: string, query: string, env: Env) => Promise<any>;
	callModel: (system: string, user: string, env: Env, maxTokens?: number) => Promise<string>;
	logRun: (userId: string, role: string, input: string, output: string, memoryIds: string[], env: Env) => Promise<string>;
};
```

### Execution Flow & Data Integrity
1. **Input Schema Validation:** Checked immediately by Zod inside the MCP registrations.
2. **Conditional Personalization:** If `use_memory` is true, invoke `buildAgentContext` using the objective/prompt query. If memory search fails, fallback gracefully (use empty memory blocks, report `memoryAvailable: false` in return payloads).
3. **LLM Invocation:** Send system policy and formatted user memory blocks to Workers AI via `llmCallSystem` (using `@cf/meta/llama-3.1-8b-instruct`).
4. **Validation and Repair Gate:**
   - For `build`/`improve`, verify outputs contain expected Markdown headers (`# Prompt`, `# Configuration`, `# Assumptions`, `# Quality check` / `# Diagnosis`, `# Improved prompt`, `# Material changes`, `# Assumptions`).
   - For `evaluate`, parse output JSON. Clamp score values to `0..100`.
   - If validation fails, initiate a single repair call passing the validation error. Do not loop.
5. **Auditing Logs:** Insert record of run via `insertAgentRun` with role `"prompt"` (or `"prompt-evaluate"`) and associate any memory IDs used.

---

## 6. Implementation Milestones

To deliver this feature safely, we suggest a 5-step milestone plan:

### Milestone 1: Policy and Validators
- **Objective:** Create the core configuration types, policy templates (`PROMPT_POLICY`, `CLAUDE_POLICY`), target-routing functions, and evaluation JSON string parsers.
- **Verification:** Unit tests verifying string matches for durable policy guidance (e.g. avoiding prefill on Claude 4.6+, validating XML tag directives) and score range bounds check.

### Milestone 2: Orchestration Runtime
- **Objective:** Build runtime orchestrators (`buildPrompt`, `improvePrompt`, `evaluatePrompt`) supporting mockable dependencies. Implement memory string block formatting and repair call ceilings.
- **Verification:** Mock dependency tests showing `use_memory: false` skips memory lookups, and incorrect JSON evaluates/repairs exactly once.

### Milestone 3: MCP Schema and Registry Registration
- **Objective:** Write `src/tools/prompt-engineering.ts` registering the three new tools. Connect `registerPromptEngineeringTools` in `src/mcp.ts`. Add the file to `scripts/check-tool-surface.mjs` and raise `EXPECTED_TOOLS` to `138` (or `113` depending on current local baseline count + 3).
- **Verification:** Run `npm run test:surface` to confirm total tool count matches the new expectation.

### Milestone 4: Prompt Agent Role Integration
- **Objective:** Append `"prompt"` to `AGENT_ROLES` in `src/types.ts` and set up the corresponding prompt role system instructions inside `src/utils/agents.ts`.
- **Verification:** Run source-mapping checks assuring role wiring matches specifications.

### Milestone 5: Behaviour Evals and Deployment Gate
- **Objective:** Formulate five behavior test cases (e.g., long-context Claude prompt building, narrow Codex bug fixes, structured extraction outputs) in `docs/superpowers/evals/prompt-intelligence/README.md`.
- **Verification:** Confirm all tests exit 0 (`npm run test:all`). Check Cloudflare environment variables, deploy (`npm run deploy`), and execute live SSE tool invocations.
