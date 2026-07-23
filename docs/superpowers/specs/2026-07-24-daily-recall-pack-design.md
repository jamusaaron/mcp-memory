# MCP Memory Daily Recall Pack Design

**Date:** 24 July 2026

## Objective

Add four focused MCP tools that make everyday memory use faster: record decisions consistently, recall past decisions, review what changed, and create a recent digest for a topic. The tools will build on the existing memory table, D1 helpers, Vectorize search, and Workers AI integration without adding a database migration or changing existing tool behavior.

## Success criteria

The enhancement is complete when:

1. `remember_decision` stores a self-contained decision memory with consistent decision and project tags, rationale, alternatives, and decision date.
2. `recall_decisions` retrieves relevant decisions by semantic topic, project, and optional date range without returning unrelated memories.
3. `what_changed` reports active memories created or materially updated after a caller-supplied point in time and distinguishes created from updated records.
4. `topic_digest` summarizes recent memories relevant to a topic and cites the supporting memory IDs in both readable and structured output.
5. All four tools return readable `content` plus validated `structuredContent`.
6. Existing tools and stored data remain compatible, the tool-surface count is updated from 135 to 139, and all tests and TypeScript checks pass.
7. Deployment is attempted only after local tests, the compiler gate, and a Wrangler dry-run pass.

## Considered approaches

### Minimal read-only pair

Add only `what_changed` and `topic_digest`. This has the smallest surface and avoids new write behavior, but decisions remain inconsistently stored and difficult to retrieve precisely.

### Daily Recall Pack — selected

Add two decision tools and two review tools. This creates a coherent daily workflow while reusing the current memory model. It provides a stable contract without introducing a separate decisions subsystem.

### One `daily_copilot` tool

Combine recent changes, decisions, and topic summaries into one broad tool. This reduces tool selection but overlaps `get_session_brief`, makes output less predictable, and couples independent use cases.

## Architecture

### `src/tools/daily-recall.ts`

Register the four tools through `McpServer.registerTool` so each tool can declare an `outputSchema`. Keep the module independent of session and agent orchestration code.

The module will use:

- `insertMemory`, `getMemoryById`, `queryMemoryChanges`, and `queryMemoriesByTags` from `src/utils/db.ts`;
- `searchMemories` from `src/utils/vectorize.ts`;
- a new deterministic digest helper from `src/utils/daily-recall.ts`;
- `toolStructured` and `toolError` from `src/utils/tool-result.ts`.

No existing tool will be renamed, wrapped, or behaviorally changed.

### `src/utils/daily-recall.ts`

Own pure normalization, filtering, and formatting logic:

```ts
type DecisionInput = {
	decision: string;
	rationale?: string;
	project?: string;
	alternatives?: string[];
	decidedAt?: string;
	tags?: string[];
};

type MemoryChange = {
	id: string;
	changeType: "created" | "updated";
	changedAt: string;
	category: string;
	subject?: string;
	text: string;
};

type DigestSource = {
	id: string;
	createdAt: string;
	category: string;
	text: string;
	relevance: number;
};
```

The helper will:

- normalize project names into a stable `project:<slug>` tag;
- guarantee the `decision` tag and deduplicate caller tags;
- format a decision as a self-contained memory statement;
- classify a record as `updated` only when `updated_at` is later than `created_at`;
- rank digest sources deterministically before any summary generation;
- validate and clamp caller limits.

### `src/utils/db.ts`

Add `queryMemoryChanges(userId, since, env, limit)` using one parameterized D1 query:

```sql
SELECT *
FROM memories
WHERE userId = ?
  AND suppressed = 0
  AND (created_at >= ? OR updated_at >= ?)
ORDER BY MAX(created_at, updated_at) DESC
LIMIT ?
```

This helper returns ordinary `Memory[]`; change classification remains in the pure utility module. Existing date queries continue to mean “created during range” and are not changed.

### `src/utils/tool-result.ts`

Add a generic `toolStructured(text, structuredContent)` helper that preserves the existing human-readable text response while adding JSON-compatible `structuredContent`. Existing `toolText` and `toolError` behavior remains unchanged.

### `src/mcp.ts`

Register `registerDailyRecallTools` after the existing memory tools because the new tools compose memory primitives but do not replace them.

## Tool contracts

### `remember_decision`

Inputs:

- `decision` — required, non-empty decision statement;
- `rationale` — optional explanation;
- `project` — optional project name;
- `alternatives` — optional rejected or deferred alternatives;
- `decided_at` — optional ISO timestamp, defaults to now;
- `tags` — optional additional tags.

Behavior:

1. Validate `decided_at` and normalize the project tag.
2. Build a self-contained memory statement containing the decision, date, rationale, and alternatives.
3. Store it as category `projects`, layer `long_embedded`, source type `stated`, with default confidence `0.9` and salience `0.8`.
4. Add `decision` and, when present, `project:<slug>` tags.
5. Attempt embedding using the same best-effort behavior as `remember`; storage success is not rolled back if embedding fails.

Output:

```ts
{
	id: string;
	decision: string;
	project?: string;
	decided_at: string;
	tags: string[];
	embedding_status: "embedded" | "pending";
}
```

### `recall_decisions`

Inputs:

- `query` — optional topic text;
- `project` — optional project name;
- `start_date` and `end_date` — optional ISO bounds that must be supplied together;
- `limit` — defaults to 10, maximum 50.

Behavior:

1. Fetch memories tagged `decision`, optionally intersected with the normalized project tag.
2. If `query` is present, merge semantic hits with tagged results by memory ID and retain only decision-tagged records.
3. Apply date filtering to the stored decision date when present, otherwise `created_at`.
4. Sort by decision date descending, then relevance, and return at most `limit`.

Output:

```ts
{
	count: number;
	decisions: Array<{
		id: string;
		decision: string;
		project?: string;
		decided_at: string;
		rationale?: string;
		alternatives: string[];
		relevance?: number;
	}>;
}
```

### `what_changed`

Inputs:

- `since` — required ISO timestamp;
- `limit` — defaults to 25, maximum 100;
- `categories` — optional category filter.

Behavior:

1. Query active memories created or updated since `since`.
2. Exclude unchanged and suppressed records.
3. Classify each record as `created` or `updated`.
4. Sort newest first using the effective change timestamp.

Output:

```ts
{
	since: string;
	generated_at: string;
	counts: { created: number; updated: number };
	changes: MemoryChange[];
}
```

### `topic_digest`

Inputs:

- `topic` — required;
- `days` — defaults to 14, range 1 to 365;
- `max_sources` — defaults to 12, range 1 to 30;
- `include_decisions` — defaults to true.

Behavior:

1. Retrieve semantic hits for the topic.
2. Load full active records, keep only those created or updated in the requested window, and optionally exclude decision-tagged records.
3. Rank by relevance, salience, and recency; use the top `max_sources`.
4. Generate a concise factual digest through Workers AI using only the selected source text.
5. If Workers AI fails or returns empty text, return a deterministic extractive digest instead.
6. Include every supporting memory ID in readable and structured output; do not invent uncited facts.

Output:

```ts
{
	topic: string;
	window: { start: string; end: string; days: number };
	digest: string;
	sources: DigestSource[];
}
```

## Data flow

### Decision write

1. Zod validates the MCP input.
2. Pure helpers normalize date, tags, project, and text.
3. `insertMemory` writes the ordinary memory record.
4. Vectorize embedding runs best-effort and updates embedding status.
5. `toolStructured` returns readable confirmation plus the structured record.

### Decision recall and change review

1. Zod validates ranges and limits.
2. D1 retrieves the bounded candidate set.
3. Pure helpers filter, classify, deduplicate, and sort.
4. The tool returns structured results and a compact readable rendering.

### Topic digest

1. Vectorize supplies topic candidates.
2. D1 supplies authoritative metadata and active/suppressed state.
3. Pure ranking selects a bounded source set.
4. Workers AI receives only cited sources and a factual summarization instruction.
5. The response returns the digest plus source IDs; deterministic fallback handles AI failure.

## Error handling

- Invalid ISO dates fail before D1 or Workers AI calls.
- `recall_decisions` rejects a lone `start_date` or `end_date`.
- Empty decision, query, or topic strings are rejected by Zod.
- Limits and day windows are bounded in the schema.
- A D1 failure returns `toolError` and does not produce partial success.
- A decision embedding failure returns success with `embedding_status: "pending"`.
- An empty recall or change query returns a successful zero-count response.
- An empty topic source set returns a successful response stating that no recent evidence was found.
- Workers AI failure falls back to a deterministic source summary and is identified in readable output.

## Testing strategy

### Pure unit tests

Create `tests/daily-recall.test.ts` to verify:

- project tag normalization and tag deduplication;
- self-contained decision formatting with and without optional fields;
- created-versus-updated classification;
- date-range validation;
- deterministic digest ranking and fallback rendering.

### Tool registration and contract tests

Create `tests/daily-recall-tools.test.ts` with a fake MCP registry and test environment to verify:

- all four names register once;
- each tool declares its intended input and output schema;
- `remember_decision` writes the expected ordinary memory metadata;
- `recall_decisions` never returns non-decision memories;
- `what_changed` distinguishes created and updated records;
- `topic_digest` cites only the selected memory IDs and falls back when AI fails;
- each successful result includes both readable `content` and `structuredContent`.

### Repository gates

1. Run the focused new tests and confirm they fail before implementation.
2. Implement the smallest behavior needed for them to pass.
3. Run `npm test`.
4. Run `npm run test:surface` with expected count `139`.
5. Run `npx tsc --noEmit`.
6. Run `npx wrangler deploy --dry-run --outdir /tmp/mcp-memory-daily-recall-dry-run`.

## Compatibility and rollout

- No D1 migration or new Cloudflare binding is required.
- Existing memory rows remain valid.
- Existing tools and output formats remain unchanged.
- New decision records remain accessible through `recall`, `query_memories`, and exports because they are ordinary memories.
- Tool names are additive; the expected surface count changes from 135 to 139.
- Production deployment occurs only after all local gates pass.
- Live verification calls all four new tools through the MCP connector, using disposable test content that is cleaned up afterward.

## Deferred work

- A dedicated decisions table or decision status workflow.
- Automatic extraction of decisions from every conversation.
- Cross-user or team decision sharing.
- Scheduled daily digest delivery.
- Editing or superseding decisions as a separate lifecycle.
- Background digest caching.
