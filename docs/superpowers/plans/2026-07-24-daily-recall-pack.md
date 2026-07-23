# Daily Recall Pack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `remember_decision`, `recall_decisions`, `what_changed`, and `topic_digest` as additive, typed MCP memory tools.

**Architecture:** Put deterministic normalization, parsing, change classification, source ranking, and fallback rendering in a pure `src/utils/daily-recall.ts` module. Add one bounded D1 query helper, then register four `McpServer.registerTool` contracts from `src/tools/daily-recall.ts` using dependency-injected handlers so tool behavior is testable without a live Worker.

**Tech Stack:** TypeScript, Node test runner, Zod 3, MCP SDK 1.26, Cloudflare Workers, D1, Vectorize, Workers AI.

## Global Constraints

- Preserve every existing MCP tool and its output behavior.
- Return readable `content` alongside `structuredContent` for all four new tools.
- Add no D1 migration and no Cloudflare binding.
- Store decisions as ordinary memories with category `projects`, layer `long_embedded`, source type `stated`, confidence `0.9`, and salience `0.8`.
- Bound all queries and AI inputs; never summarize memories outside the selected source set.
- Preserve unrelated worktree changes in `src/utils/prompt-engineering.ts`, `tests/prompt-engineering.test.ts`, `wrangler.jsonc`, `.DS_Store`, and `tests/wrangler-routing.test.ts`.
- Stage only files named in each task.
- Update the expected MCP tool count from `135` to `139`.
- Do not push the branch without separate user approval.

---

## File structure

- Create `src/utils/daily-recall.ts` — pure types, date validation, project/tag normalization, decision serialization/parsing, change classification, source ranking, and extractive fallback.
- Create `src/tools/daily-recall.ts` — dependency interface, four handlers, four MCP schemas, and registration.
- Create `tests/daily-recall.test.ts` — pure utility tests.
- Create `tests/daily-recall-tools.test.ts` — handler and structured-contract tests with deterministic fakes.
- Modify `src/utils/db.ts` — add `queryMemoryChanges`.
- Modify `src/utils/tool-result.ts` — add `toolStructured`.
- Modify `tests/db.test.ts` — cover the bounded change query.
- Modify `tests/tool-result.test.ts` — cover readable plus structured results.
- Modify `src/mcp.ts` — register the new module after base memory tools.
- Modify `scripts/check-tool-surface.mjs` — include the new tool file and expect 139 tools.

### Task 1: Structured MCP result helper

**Files:**
- Modify: `src/utils/tool-result.ts`
- Modify: `tests/tool-result.test.ts`

**Interfaces:**
- Consumes: JSON-compatible objects supplied by tool handlers.
- Produces: `toolStructured<T extends Record<string, unknown>>(text: string, structuredContent: T)`.

- [ ] **Step 1: Write the failing structured-result test**

Add the import and test:

```ts
import { toolError, toolStructured, toolText } from "../src/utils/tool-result";

test("toolStructured preserves readable text and typed structured content", () => {
	assert.deepEqual(toolStructured("Stored decision d1.", { id: "d1", stored: true }), {
		content: [{ type: "text", text: "Stored decision d1." }],
		structuredContent: { id: "d1", stored: true },
	});
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --import tsx --test tests/tool-result.test.ts
```

Expected: FAIL because `toolStructured` is not exported.

- [ ] **Step 3: Implement the minimal helper**

Append to `src/utils/tool-result.ts`:

```ts
export type ToolStructuredResult<T extends Record<string, unknown>> = {
	content: Array<{ type: "text"; text: string }>;
	structuredContent: T;
};

export function toolStructured<T extends Record<string, unknown>>(
	text: string,
	structuredContent: T,
): ToolStructuredResult<T> {
	return {
		content: [{ type: "text", text }],
		structuredContent,
	};
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
node --import tsx --test tests/tool-result.test.ts
```

Expected: 3 tests pass, 0 fail.

- [ ] **Step 5: Commit only the helper files**

```bash
git add src/utils/tool-result.ts tests/tool-result.test.ts
git commit -m "feat: add structured MCP result helper"
```

### Task 2: Pure Daily Recall domain helpers

**Files:**
- Create: `src/utils/daily-recall.ts`
- Create: `tests/daily-recall.test.ts`

**Interfaces:**
- Consumes: existing `Memory` records and caller decision inputs.
- Produces:
  - `parseIsoTimestamp(value: string, field: string): string`
  - `projectTag(project: string): string`
  - `buildDecisionRecord(input: DecisionInput, now: string): DecisionRecord`
  - `parseDecisionMemory(memory: Memory, relevance?: number): DecisionView | null`
  - `classifyMemoryChanges(memories: Memory[], since: string, categories?: string[], limit?: number): MemoryChange[]`
  - `rankDigestSources(candidates: DigestCandidate[], now: string, maxSources: number): DigestSource[]`
  - `renderExtractiveDigest(topic: string, sources: DigestSource[]): string`
  - `digestHasValidCitations(digest: string, sources: DigestSource[]): boolean`

- [ ] **Step 1: Write failing tests for decision normalization**

Create `tests/daily-recall.test.ts` with:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import type { Memory } from "../src/types";
import {
	buildDecisionRecord,
	classifyMemoryChanges,
	digestHasValidCitations,
	parseDecisionMemory,
	projectTag,
	rankDigestSources,
	renderExtractiveDigest,
} from "../src/utils/daily-recall";

const baseMemory = (overrides: Partial<Memory> = {}): Memory => ({
	id: "m1",
	userId: "u1",
	category: "projects",
	layer: "long_embedded",
	subject: "Choose durable storage",
	text: "Decision: Choose D1\\nDecided: 2026-07-24T00:00:00.000Z",
	tags: ["decision"],
	triggers: [],
	confidence: 0.9,
	salience: 0.8,
	emotion_weight: 0,
	source_type: "stated",
	linked_people: [],
	embedding_status: "embedded",
	suppressed: false,
	suppression_reason: null,
	pinned: false,
	access_count: 0,
	last_accessed: null,
	last_verified: null,
	created_at: "2026-07-24T00:00:00.000Z",
	updated_at: "2026-07-24T00:00:00.000Z",
	...overrides,
});

test("projectTag creates a stable namespaced slug", () => {
	assert.equal(projectTag("MCP Memory / Daily Recall"), "project:mcp-memory-daily-recall");
});

test("buildDecisionRecord adds stable tags and complete readable fields", () => {
	const result = buildDecisionRecord(
		{
			decision: "Use the Daily Recall Pack",
			rationale: "It fills daily retrieval gaps.",
			project: "MCP Memory",
			alternatives: ["One mega tool", "No change"],
			tags: ["Daily", "decision", "daily"],
		},
		"2026-07-24T02:00:00.000Z",
	);
	assert.deepEqual(result.tags, ["decision", "project:mcp-memory", "daily"]);
	assert.match(result.text, /^Decision: Use the Daily Recall Pack/m);
	assert.match(result.text, /^Rationale: It fills daily retrieval gaps\.$/m);
	assert.match(result.text, /^Alternatives:\\n- One mega tool\\n- No change$/m);
	assert.equal(result.decidedAt, "2026-07-24T02:00:00.000Z");
});

test("parseDecisionMemory returns null for ordinary memories", () => {
	assert.equal(parseDecisionMemory(baseMemory({ tags: ["project:mcp-memory"] })), null);
});

test("parseDecisionMemory restores decision fields", () => {
	const record = buildDecisionRecord(
		{
			decision: "Ship four tools",
			rationale: "They form one workflow.",
			project: "MCP Memory",
			alternatives: ["Ship two"],
		},
		"2026-07-24T03:00:00.000Z",
	);
	const parsed = parseDecisionMemory(
		baseMemory({ text: record.text, tags: record.tags, subject: record.subject }),
		0.87,
	);
	assert.deepEqual(parsed, {
		id: "m1",
		decision: "Ship four tools",
		project: "MCP Memory",
		decided_at: "2026-07-24T03:00:00.000Z",
		rationale: "They form one workflow.",
		alternatives: ["Ship two"],
		relevance: 0.87,
	});
});
```

- [ ] **Step 2: Run the utility test and verify RED**

Run:

```bash
node --import tsx --test tests/daily-recall.test.ts
```

Expected: FAIL because `src/utils/daily-recall.ts` does not exist.

- [ ] **Step 3: Implement decision normalization and parsing**

Create `src/utils/daily-recall.ts` with the following public types and implementation:

```ts
import type { Memory } from "../types";

export type DecisionInput = {
	decision: string;
	rationale?: string;
	project?: string;
	alternatives?: string[];
	decidedAt?: string;
	tags?: string[];
};

export type DecisionRecord = {
	text: string;
	subject: string;
	tags: string[];
	decidedAt: string;
};

export type DecisionView = {
	id: string;
	decision: string;
	project?: string;
	decided_at: string;
	rationale?: string;
	alternatives: string[];
	relevance?: number;
};

export type MemoryChange = {
	id: string;
	changeType: "created" | "updated";
	changedAt: string;
	category: string;
	subject?: string;
	text: string;
};

export type DigestCandidate = {
	memory: Memory;
	relevance: number;
};

export type DigestSource = {
	id: string;
	createdAt: string;
	category: string;
	text: string;
	relevance: number;
};

export function parseIsoTimestamp(value: string, field: string): string {
	const date = new Date(value);
	if (!Number.isFinite(date.getTime())) throw new Error(`${field} must be a valid ISO timestamp`);
	return date.toISOString();
}

export function projectTag(project: string): string {
	const slug = project
		.normalize("NFKD")
		.replace(/[^\w\s-]/g, "")
		.trim()
		.toLowerCase()
		.replace(/[\s_]+/g, "-")
		.replace(/-+/g, "-");
	if (!slug) throw new Error("project must contain at least one letter or number");
	return `project:${slug}`;
}

function cleanTags(tags: string[]): string[] {
	return [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
}

export function buildDecisionRecord(input: DecisionInput, now: string): DecisionRecord {
	const decidedAt = parseIsoTimestamp(input.decidedAt ?? now, "decided_at");
	const decision = input.decision.trim();
	if (!decision) throw new Error("decision must not be empty");
	const alternatives = (input.alternatives ?? []).map((value) => value.trim()).filter(Boolean);
	const tags = cleanTags([
		"decision",
		...(input.project ? [projectTag(input.project)] : []),
		...(input.tags ?? []),
	]);
	const lines = [`Decision: ${decision}`, `Decided: ${decidedAt}`];
	if (input.project?.trim()) lines.push(`Project: ${input.project.trim()}`);
	if (input.rationale?.trim()) lines.push(`Rationale: ${input.rationale.trim()}`);
	if (alternatives.length) lines.push(`Alternatives:\n${alternatives.map((item) => `- ${item}`).join("\n")}`);
	return {
		text: lines.join("\n"),
		subject: decision.split(/\s+/).slice(0, 10).join(" "),
		tags,
		decidedAt,
	};
}

function field(text: string, name: string): string | undefined {
	return text.match(new RegExp(`^${name}:\\\\s*(.+)$`, "mi"))?.[1]?.trim();
}

export function parseDecisionMemory(memory: Memory, relevance?: number): DecisionView | null {
	if (!memory.tags.includes("decision")) return null;
	const decision = field(memory.text, "Decision");
	if (!decision) return null;
	const alternativesBlock = memory.text.match(/^Alternatives:\s*\n((?:- .+(?:\n|$))*)/mi)?.[1] ?? "";
	return {
		id: memory.id,
		decision,
		...(field(memory.text, "Project") ? { project: field(memory.text, "Project") } : {}),
		decided_at: parseIsoTimestamp(field(memory.text, "Decided") ?? memory.created_at, "decided_at"),
		...(field(memory.text, "Rationale")
			? { rationale: field(memory.text, "Rationale") }
			: {}),
		alternatives: alternativesBlock
			.split("\n")
			.map((line) => line.replace(/^- /, "").trim())
			.filter(Boolean),
		...(relevance === undefined ? {} : { relevance }),
	};
}
```

- [ ] **Step 4: Add failing tests for change classification and digest ranking**

Append:

```ts
test("classifyMemoryChanges distinguishes created from updated", () => {
	const changes = classifyMemoryChanges(
		[
			baseMemory({ id: "new", created_at: "2026-07-24T02:00:00.000Z", updated_at: "2026-07-24T02:00:00.000Z" }),
			baseMemory({ id: "edited", created_at: "2026-07-20T00:00:00.000Z", updated_at: "2026-07-24T03:00:00.000Z" }),
			baseMemory({ id: "old", created_at: "2026-07-19T00:00:00.000Z", updated_at: "2026-07-19T00:00:00.000Z" }),
		],
		"2026-07-24T00:00:00.000Z",
	);
	assert.deepEqual(
		changes.map(({ id, changeType }) => ({ id, changeType })),
		[
			{ id: "edited", changeType: "updated" },
			{ id: "new", changeType: "created" },
		],
	);
});

test("rankDigestSources prefers relevance then recency and remains bounded", () => {
	const ranked = rankDigestSources(
		[
			{ memory: baseMemory({ id: "a", salience: 0.5, updated_at: "2026-07-23T00:00:00.000Z" }), relevance: 0.9 },
			{ memory: baseMemory({ id: "b", salience: 1, updated_at: "2026-07-24T00:00:00.000Z" }), relevance: 0.7 },
		],
		"2026-07-24T04:00:00.000Z",
		1,
	);
	assert.deepEqual(ranked.map((source) => source.id), ["a"]);
});

test("renderExtractiveDigest cites every rendered memory", () => {
	const text = renderExtractiveDigest("MCP memory", [
		{ id: "a", createdAt: "2026-07-24T00:00:00.000Z", category: "projects", text: "Added daily recall.", relevance: 0.9 },
	]);
	assert.equal(text, '- [a] Added daily recall.');
});

test("digestHasValidCitations rejects missing and unknown source IDs", () => {
	const sources = [
		{ id: "a", createdAt: "2026-07-24T00:00:00.000Z", category: "projects", text: "Added daily recall.", relevance: 0.9 },
	];
	assert.equal(digestHasValidCitations("Added daily recall.", sources), false);
	assert.equal(digestHasValidCitations("Added daily recall [other].", sources), false);
	assert.equal(digestHasValidCitations("Added daily recall [a].", sources), true);
});
```

- [ ] **Step 5: Run the utility test and verify RED for the new exports**

Run:

```bash
node --import tsx --test tests/daily-recall.test.ts
```

Expected: FAIL because the three new functions are not exported.

- [ ] **Step 6: Implement change classification, ranking, and fallback rendering**

Append:

```ts
export function classifyMemoryChanges(
	memories: Memory[],
	since: string,
	categories?: string[],
	limit = 100,
): MemoryChange[] {
	const threshold = parseIsoTimestamp(since, "since");
	return memories
		.filter((memory) => !memory.suppressed)
		.filter((memory) => !categories?.length || categories.includes(memory.category))
		.map((memory) => {
			const createdAt = parseIsoTimestamp(memory.created_at, "created_at");
			const updatedAt = parseIsoTimestamp(memory.updated_at, "updated_at");
			const createdSinceThreshold = createdAt >= threshold;
			return {
				id: memory.id,
				changeType: createdSinceThreshold ? ("created" as const) : ("updated" as const),
				changedAt: createdSinceThreshold ? createdAt : updatedAt,
				category: memory.category,
				...(memory.subject ? { subject: memory.subject } : {}),
				text: memory.text,
			};
		})
		.filter((change) => change.changedAt >= threshold)
		.sort((a, b) => b.changedAt.localeCompare(a.changedAt))
		.slice(0, Math.max(0, limit));
}

export function rankDigestSources(
	candidates: DigestCandidate[],
	now: string,
	maxSources: number,
): DigestSource[] {
	const nowMs = new Date(parseIsoTimestamp(now, "now")).getTime();
	return candidates
		.map(({ memory, relevance }) => {
			const effectiveAt = memory.updated_at > memory.created_at ? memory.updated_at : memory.created_at;
			const ageDays = Math.max(0, (nowMs - new Date(effectiveAt).getTime()) / 86_400_000);
			const recency = 1 / (1 + ageDays / 30);
			const score = relevance * 0.7 + memory.salience * 0.2 + recency * 0.1;
			return {
				source: {
					id: memory.id,
					createdAt: memory.created_at,
					category: memory.category,
					text: memory.text,
					relevance: Number(relevance.toFixed(4)),
				},
				score,
			};
		})
		.sort((a, b) => b.score - a.score || b.source.createdAt.localeCompare(a.source.createdAt))
		.slice(0, Math.max(0, maxSources))
		.map(({ source }) => source);
}

export function renderExtractiveDigest(_topic: string, sources: DigestSource[]): string {
	return sources.map((source) => `- [${source.id}] ${source.text}`).join("\n");
}

export function digestHasValidCitations(digest: string, sources: DigestSource[]): boolean {
	if (!digest.trim() || sources.length === 0) return false;
	const known = new Set(sources.map((source) => source.id));
	const citations = [...digest.matchAll(/\[([^\]]+)\]/g)].map((match) => match[1]);
	return citations.length > 0 && citations.every((id) => known.has(id));
}
```

- [ ] **Step 7: Run the utility test and verify GREEN**

Run:

```bash
node --import tsx --test tests/daily-recall.test.ts
```

Expected: all Daily Recall utility tests pass.

- [ ] **Step 8: Commit the pure helper**

```bash
git add src/utils/daily-recall.ts tests/daily-recall.test.ts
git commit -m "feat: add daily recall domain helpers"
```

### Task 3: Bounded memory-change query

**Files:**
- Modify: `src/utils/db.ts`
- Modify: `tests/db.test.ts`

**Interfaces:**
- Consumes: `userId`, normalized ISO `since`, `Env`, bounded `limit`.
- Produces: `queryMemoryChanges(userId: string, since: string, env: Env, limit?: number): Promise<Memory[]>`.

- [ ] **Step 1: Add a failing D1 query test**

Append a test using the existing fake D1 pattern:

```ts
test("queryMemoryChanges binds user, both timestamps, and bounded limit", async () => {
	const calls: Array<{ sql: string; values: unknown[] }> = [];
	const env = {
		DB: {
			prepare(sql: string) {
				return {
					bind(...values: unknown[]) {
						calls.push({ sql, values });
						return { all: async () => ({ results: [] }) };
					},
				};
			},
		},
	} as unknown as Env;

	const { queryMemoryChanges } = await import("../src/utils/db");
	await queryMemoryChanges("u1", "2026-07-24T00:00:00.000Z", env, 25);

	assert.match(calls[0].sql, /suppressed=0/);
	assert.match(calls[0].sql, /created_at>=\? OR updated_at>=\?/);
	assert.match(calls[0].sql, /LIMIT \?/);
	assert.deepEqual(calls[0].values, [
		"u1",
		"2026-07-24T00:00:00.000Z",
		"2026-07-24T00:00:00.000Z",
		25,
	]);
});
```

- [ ] **Step 2: Run the DB test and verify RED**

Run:

```bash
node --import tsx --test tests/db.test.ts
```

Expected: FAIL because `queryMemoryChanges` is not exported.

- [ ] **Step 3: Implement the query**

Add after `queryMemoriesByDate`:

```ts
export async function queryMemoryChanges(
	userId: string,
	since: string,
	env: Env,
	limit = 100,
): Promise<Memory[]> {
	const boundedLimit = Math.min(100, Math.max(1, Math.trunc(limit)));
	const res = await env.DB.prepare(
		`SELECT * FROM memories
		 WHERE userId=?
		   AND suppressed=0
		   AND (created_at>=? OR updated_at>=?)
		 ORDER BY CASE WHEN updated_at>created_at THEN updated_at ELSE created_at END DESC
		 LIMIT ?`,
	)
		.bind(userId, since, since, boundedLimit)
		.all();
	return (res.results as Record<string, unknown>[]).map(rowToMemory);
}
```

- [ ] **Step 4: Run the DB test and verify GREEN**

Run:

```bash
node --import tsx --test tests/db.test.ts
```

Expected: all DB tests pass.

- [ ] **Step 5: Commit the query helper**

```bash
git add src/utils/db.ts tests/db.test.ts
git commit -m "feat: query recent memory changes"
```

### Task 4: Decision handlers and MCP contracts

**Files:**
- Create: `src/tools/daily-recall.ts`
- Create: `tests/daily-recall-tools.test.ts`

**Interfaces:**
- Consumes:
  - domain helpers from Task 2;
  - DB and Vectorize functions through `DailyRecallDependencies`.
- Produces:
  - `createDailyRecallHandlers(userId, env, deps?)`;
  - `registerDailyRecallTools(server, env, userId)`;
  - decision handler methods `rememberDecision` and `recallDecisions`.

- [ ] **Step 1: Write failing decision-handler tests**

Create `tests/daily-recall-tools.test.ts` with a deterministic harness:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import type { Memory } from "../src/types";
import {
	createDailyRecallHandlers,
	type DailyRecallDependencies,
} from "../src/tools/daily-recall";

function harness() {
	const stored: Memory[] = [];
	const deps: DailyRecallDependencies = {
		now: () => new Date("2026-07-24T04:00:00.000Z"),
		insertMemory: async (input) => {
			const memory = {
				...input,
				id: `decision-${stored.length + 1}`,
				subject: input.subject ?? null,
				tags: input.tags ?? [],
				triggers: input.triggers ?? [],
				linked_people: [],
				emotion_weight: 0,
				embedding_status: "pending",
				suppressed: false,
				suppression_reason: null,
				pinned: false,
				access_count: 0,
				last_accessed: null,
				last_verified: null,
				created_at: "2026-07-24T04:00:00.000Z",
				updated_at: "2026-07-24T04:00:00.000Z",
			} as Memory;
			stored.push(memory);
			return memory;
		},
		updateMemory: async (id, _userId, updates) => {
			const memory = stored.find((item) => item.id === id);
			if (memory) Object.assign(memory, updates);
		},
		getMemoryById: async (id) => stored.find((memory) => memory.id === id) ?? null,
		queryMemoriesByTags: async () => stored,
		queryMemoryChanges: async () => stored,
		searchMemories: async () =>
			stored.map((memory) => ({ id: memory.id, content: memory.text, score: 0.91 })),
		storeMemoryVector: async () => {},
		callModel: async () => "Digest [decision-1]",
	};
	return { stored, deps };
}

function structured<T extends Record<string, unknown>>(result: object): T {
	assert.ok("structuredContent" in result);
	return (result as { structuredContent: T }).structuredContent;
}

test("rememberDecision writes an ordinary decision memory and returns both result forms", async () => {
	const { stored, deps } = harness();
	const handlers = createDailyRecallHandlers("u1", {} as Env, deps);
	const result = await handlers.rememberDecision({
		decision: "Ship four daily tools",
		rationale: "They form one coherent workflow.",
		project: "MCP Memory",
		alternatives: ["Ship two"],
		tags: ["Daily"],
	});
	assert.equal(stored[0].category, "projects");
	assert.equal(stored[0].layer, "long_embedded");
	assert.equal(stored[0].confidence, 0.9);
	assert.equal(stored[0].salience, 0.8);
	assert.deepEqual(stored[0].tags, ["decision", "project:mcp-memory", "daily"]);
	assert.match(result.content[0].text, /decision-1/);
	const data = structured<{ id: string; embedding_status: string }>(result);
	assert.equal(data.id, "decision-1");
	assert.equal(data.embedding_status, "embedded");
});

test("recallDecisions excludes ordinary and query-irrelevant memories", async () => {
	const { stored, deps } = harness();
	const handlers = createDailyRecallHandlers("u1", {} as Env, deps);
	await handlers.rememberDecision({
		decision: "Ship daily tools",
		project: "MCP Memory",
	});
	const decision = stored[0];
	const ordinary = { ...decision, id: "ordinary", tags: ["project:mcp-memory"] };
	const unrelated = {
		...decision,
		id: "unrelated",
		text: decision.text.replace("Ship daily tools", "Choose a database"),
	};
	deps.queryMemoriesByTags = async () => [decision, ordinary, unrelated];
	deps.searchMemories = async () => [
		{ id: decision.id, content: decision.text, score: 0.92 },
	];
	const result = await handlers.recallDecisions({
		query: "daily tools",
		project: "MCP Memory",
		limit: 10,
	});
	const data = structured<{ count: number; decisions: Array<{ id: string }> }>(result);
	assert.equal(data.count, 1);
	assert.deepEqual(data.decisions.map((item) => item.id), ["decision-1"]);
});
```

- [ ] **Step 2: Run the handler test and verify RED**

Run:

```bash
node --import tsx --test tests/daily-recall-tools.test.ts
```

Expected: FAIL because `src/tools/daily-recall.ts` does not exist.

- [ ] **Step 3: Create the dependency boundary and decision handlers**

Create `src/tools/daily-recall.ts` with imports, dependency types, defaults, and these handler shapes:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CATEGORIES, type Memory } from "../types";
import {
	getMemoryById,
	insertMemory,
	queryMemoryChanges,
	queryMemoriesByTags,
	updateMemory,
} from "../utils/db";
import {
	buildDecisionRecord,
	classifyMemoryChanges,
	digestHasValidCitations,
	parseDecisionMemory,
	parseIsoTimestamp,
	projectTag,
	rankDigestSources,
	renderExtractiveDigest,
} from "../utils/daily-recall";
import { llmCallSystem } from "../utils/ai";
import { toolError, toolStructured } from "../utils/tool-result";
import { searchMemories, storeMemoryVector } from "../utils/vectorize";

export type DailyRecallDependencies = {
	now: () => Date;
	insertMemory: typeof insertMemory;
	updateMemory: typeof updateMemory;
	getMemoryById: typeof getMemoryById;
	queryMemoriesByTags: typeof queryMemoriesByTags;
	queryMemoryChanges: typeof queryMemoryChanges;
	searchMemories: typeof searchMemories;
	storeMemoryVector: typeof storeMemoryVector;
	callModel: typeof llmCallSystem;
};

const DEFAULT_DEPS: DailyRecallDependencies = {
	now: () => new Date(),
	insertMemory,
	updateMemory,
	getMemoryById,
	queryMemoriesByTags,
	queryMemoryChanges,
	searchMemories,
	storeMemoryVector,
	callModel: llmCallSystem,
};

export function createDailyRecallHandlers(
	userId: string,
	env: Env,
	deps: DailyRecallDependencies = DEFAULT_DEPS,
) {
	return {
		async rememberDecision(input: {
			decision: string;
			rationale?: string;
			project?: string;
			alternatives?: string[];
			decided_at?: string;
			tags?: string[];
		}) {
			try {
				const record = buildDecisionRecord(
					{
						decision: input.decision,
						rationale: input.rationale,
						project: input.project,
						alternatives: input.alternatives,
						decidedAt: input.decided_at,
						tags: input.tags,
					},
					deps.now().toISOString(),
				);
				const memory = await deps.insertMemory(
					{
						userId,
						text: record.text,
						subject: record.subject,
						tags: record.tags,
						category: "projects",
						layer: "long_embedded",
						source_type: "stated",
						confidence: 0.9,
						salience: 0.8,
					},
					env,
				);
				let embedding_status: "embedded" | "pending" = "pending";
				try {
					await deps.storeMemoryVector(memory.id, memory.text, userId, env, {
						category: memory.category,
						layer: memory.layer,
						salience: memory.salience,
					});
					await deps.updateMemory(memory.id, userId, { embedding_status: "embedded" }, env);
					embedding_status = "embedded";
				} catch {
					embedding_status = "pending";
				}
				const structuredContent = {
					id: memory.id,
					decision: input.decision.trim(),
					...(input.project?.trim() ? { project: input.project.trim() } : {}),
					decided_at: record.decidedAt,
					tags: record.tags,
					embedding_status,
				};
				return toolStructured(`Decision stored [${memory.id}]: ${input.decision.trim()}`, structuredContent);
			} catch (error) {
				return toolError(error);
			}
		},

		async recallDecisions(input: {
			query?: string;
			project?: string;
			start_date?: string;
			end_date?: string;
			limit: number;
		}) {
			try {
				const requiredTags = ["decision", ...(input.project ? [projectTag(input.project)] : [])];
				const tagged = await deps.queryMemoriesByTags(userId, requiredTags, env, 100);
				let byId = new Map<string, { memory: Memory; relevance?: number }>();
				for (const memory of tagged) {
					if (requiredTags.every((tag) => memory.tags.includes(tag))) byId.set(memory.id, { memory });
				}
				if (input.query?.trim()) {
					const hits = await deps.searchMemories(input.query, userId, env, 100);
					const hitScores = new Map(hits.map((hit) => [hit.id, hit.score]));
					byId = new Map(
						[...byId]
							.filter(([id]) => hitScores.has(id))
							.map(([id, value]) => [
								id,
								{ memory: value.memory, relevance: hitScores.get(id) },
							]),
					);
					for (const hit of hits) {
						if (byId.has(hit.id)) continue;
						const memory = await deps.getMemoryById(hit.id, userId, env);
						if (memory?.tags.includes("decision") && requiredTags.every((tag) => memory.tags.includes(tag))) {
							byId.set(memory.id, { memory, relevance: hit.score });
						}
					}
				}
				const start = input.start_date ? parseIsoTimestamp(input.start_date, "start_date") : undefined;
				const end = input.end_date ? parseIsoTimestamp(input.end_date, "end_date") : undefined;
				const decisions = [...byId.values()]
					.map(({ memory, relevance }) => parseDecisionMemory(memory, relevance))
					.filter((value): value is NonNullable<typeof value> => value !== null)
					.filter((value) => (!start || value.decided_at >= start) && (!end || value.decided_at <= end))
					.sort((a, b) => b.decided_at.localeCompare(a.decided_at) || (b.relevance ?? 0) - (a.relevance ?? 0))
					.slice(0, input.limit);
				const structuredContent = { count: decisions.length, decisions };
				const text = decisions.length
					? decisions.map((item) => `- [${item.id}] ${item.decided_at}: ${item.decision}`).join("\n")
					: "No matching decisions found.";
				return toolStructured(text, structuredContent);
			} catch (error) {
				return toolError(error);
			}
		},
	};
}
```

- [ ] **Step 4: Add the two decision registrations**

In the same file, define Zod input/output schemas and begin `registerDailyRecallTools`:

```ts
const decisionViewSchema = z.object({
	id: z.string(),
	decision: z.string(),
	project: z.string().optional(),
	decided_at: z.string(),
	rationale: z.string().optional(),
	alternatives: z.array(z.string()),
	relevance: z.number().optional(),
});

export function registerDailyRecallTools(server: McpServer, env: Env, userId: string) {
	const handlers = createDailyRecallHandlers(userId, env);

	server.registerTool(
		"remember_decision",
		{
			description: "Store a decision with its rationale, project, alternatives, and date as a consistently tagged ordinary memory.",
			inputSchema: z.object({
				decision: z.string().trim().min(1),
				rationale: z.string().trim().min(1).optional(),
				project: z.string().trim().min(1).optional(),
				alternatives: z.array(z.string().trim().min(1)).max(20).optional(),
				decided_at: z.string().optional(),
				tags: z.array(z.string().trim().min(1)).max(20).optional(),
			}),
			outputSchema: z.object({
				id: z.string(),
				decision: z.string(),
				project: z.string().optional(),
				decided_at: z.string(),
				tags: z.array(z.string()),
				embedding_status: z.enum(["embedded", "pending"]),
			}),
		},
		handlers.rememberDecision,
	);

	server.registerTool(
		"recall_decisions",
		{
			description: "Recall prior decisions by topic, project, or date range.",
			inputSchema: z
				.object({
					query: z.string().trim().min(1).optional(),
					project: z.string().trim().min(1).optional(),
					start_date: z.string().optional(),
					end_date: z.string().optional(),
					limit: z.number().int().min(1).max(50).default(10),
				})
				.superRefine((value, ctx) => {
					if (Boolean(value.start_date) !== Boolean(value.end_date)) {
						ctx.addIssue({
							code: z.ZodIssueCode.custom,
							message: "start_date and end_date must be supplied together",
						});
					}
				}),
			outputSchema: z.object({
				count: z.number().int().nonnegative(),
				decisions: z.array(decisionViewSchema),
			}),
		},
		handlers.recallDecisions,
	);
}
```

- [ ] **Step 5: Run the decision tests and verify GREEN**

Run:

```bash
node --import tsx --test tests/daily-recall-tools.test.ts
```

Expected: decision handler tests pass.

- [ ] **Step 6: Commit the decision tools**

```bash
git add src/tools/daily-recall.ts tests/daily-recall-tools.test.ts
git commit -m "feat: add decision memory tools"
```

### Task 5: Change review, topic digest, and tool registration

**Files:**
- Modify: `src/tools/daily-recall.ts`
- Modify: `tests/daily-recall-tools.test.ts`
- Modify: `src/mcp.ts`
- Modify: `scripts/check-tool-surface.mjs`

**Interfaces:**
- Consumes: `queryMemoryChanges`, semantic search results, authoritative D1 memory rows, Workers AI.
- Produces: `whatChanged`, `topicDigest`, complete four-tool registration, and a 139-tool surface.

- [ ] **Step 1: Add failing handler tests for changes and digest**

Append:

```ts
test("whatChanged reports created and updated counts", async () => {
	const { deps } = harness();
	deps.queryMemoryChanges = async () => [
		{
			...(await deps.insertMemory({ userId: "u1", text: "Created", category: "projects" }, {} as Env)),
			id: "created",
			created_at: "2026-07-24T01:00:00.000Z",
			updated_at: "2026-07-24T01:00:00.000Z",
		},
		{
			...(await deps.insertMemory({ userId: "u1", text: "Edited", category: "projects" }, {} as Env)),
			id: "updated",
			created_at: "2026-07-20T01:00:00.000Z",
			updated_at: "2026-07-24T02:00:00.000Z",
		},
	];
	const handlers = createDailyRecallHandlers("u1", {} as Env, deps);
	const result = await handlers.whatChanged({ since: "2026-07-24T00:00:00Z", limit: 25 });
	const data = structured<{
		counts: { created: number; updated: number };
		changes: Array<{ id: string }>;
	}>(result);
	assert.deepEqual(data.counts, { created: 1, updated: 1 });
	assert.deepEqual(data.changes.map((item) => item.id), ["updated", "created"]);
});

test("topicDigest cites selected sources and falls back when AI fails", async () => {
	const { stored, deps } = harness();
	const source = await deps.insertMemory(
		{ id: "source-1", userId: "u1", text: "Added daily tools.", category: "projects" },
		{} as Env,
	);
	source.created_at = "2026-07-24T01:00:00.000Z";
	source.updated_at = source.created_at;
	stored[0] = source;
	deps.searchMemories = async () => [{ id: source.id, content: source.text, score: 0.94 }];
	deps.getMemoryById = async () => source;
	deps.callModel = async () => {
		throw new Error("AI unavailable");
	};
	const handlers = createDailyRecallHandlers("u1", {} as Env, deps);
	const result = await handlers.topicDigest({
		topic: "daily tools",
		days: 14,
		max_sources: 12,
		include_decisions: true,
	});
	const data = structured<{ digest: string; sources: Array<{ id: string }> }>(result);
	assert.match(data.digest, /\[source-1\]/);
	assert.deepEqual(data.sources.map((item) => item.id), ["source-1"]);
	assert.match(result.content[0].text, /extractive fallback/i);
});
```

- [ ] **Step 2: Run the tool tests and verify RED**

Run:

```bash
node --import tsx --test tests/daily-recall-tools.test.ts
```

Expected: FAIL because `whatChanged` and `topicDigest` do not exist.

- [ ] **Step 3: Implement `whatChanged`**

Add to the object returned by `createDailyRecallHandlers`:

```ts
async whatChanged(input: { since: string; limit: number; categories?: string[] }) {
	try {
		const since = parseIsoTimestamp(input.since, "since");
		const memories = await deps.queryMemoryChanges(userId, since, env, input.limit);
		const changes = classifyMemoryChanges(memories, since, input.categories, input.limit);
		const counts = {
			created: changes.filter((item) => item.changeType === "created").length,
			updated: changes.filter((item) => item.changeType === "updated").length,
		};
		const structuredContent = {
			since,
			generated_at: deps.now().toISOString(),
			counts,
			changes,
		};
		const text = changes.length
			? changes
					.map((item) => `- ${item.changeType.toUpperCase()} [${item.id}] ${item.changedAt}: ${item.text}`)
					.join("\n")
			: `No memory changes since ${since}.`;
		return toolStructured(text, structuredContent);
	} catch (error) {
		return toolError(error);
	}
},
```

- [ ] **Step 4: Implement `topicDigest`**

Add to the returned object:

```ts
async topicDigest(input: {
	topic: string;
	days: number;
	max_sources: number;
	include_decisions: boolean;
}) {
	try {
		const now = deps.now();
		const start = new Date(now.getTime() - input.days * 86_400_000).toISOString();
		const hits = await deps.searchMemories(input.topic, userId, env, input.max_sources * 3);
		const candidates = [];
		for (const hit of hits) {
			const memory = await deps.getMemoryById(hit.id, userId, env);
			if (!memory || memory.suppressed) continue;
			const effectiveAt = memory.updated_at > memory.created_at ? memory.updated_at : memory.created_at;
			if (effectiveAt < start) continue;
			if (!input.include_decisions && memory.tags.includes("decision")) continue;
			candidates.push({ memory, relevance: hit.score });
		}
		const sources = rankDigestSources(candidates, now.toISOString(), input.max_sources);
		let digest = sources.length ? renderExtractiveDigest(input.topic, sources) : "";
		let usedFallback = false;
		if (sources.length) {
			const sourceText = sources.map((source) => `[${source.id}] ${source.text}`).join("\n");
			try {
				const generated = await deps.callModel(
					"Summarize only the supplied memory sources. Be concise and factual. Cite every statement with one or more source IDs in square brackets. Do not add outside facts.",
					`Topic: ${input.topic}\n\nSources:\n${sourceText}`,
					env,
					900,
				);
				if (digestHasValidCitations(generated, sources)) digest = generated.trim();
				else usedFallback = true;
			} catch {
				usedFallback = true;
			}
		}
		const structuredContent = {
			topic: input.topic,
			window: { start, end: now.toISOString(), days: input.days },
			digest: digest || "No recent evidence found for this topic.",
			sources,
		};
		const prefix = usedFallback ? "Topic digest (extractive fallback)" : "Topic digest";
		const sourceLine = sources.length
			? `\n\nSources: ${sources.map((source) => `[${source.id}]`).join(" ")}`
			: "";
		return toolStructured(
			`${prefix}\n\n${structuredContent.digest}${sourceLine}`,
			structuredContent,
		);
	} catch (error) {
		return toolError(error);
	}
},
```

- [ ] **Step 5: Register both read tools with exact schemas**

Before the closing brace of `registerDailyRecallTools`, add:

```ts
const memoryChangeSchema = z.object({
	id: z.string(),
	changeType: z.enum(["created", "updated"]),
	changedAt: z.string(),
	category: z.string(),
	subject: z.string().optional(),
	text: z.string(),
});

const digestSourceSchema = z.object({
	id: z.string(),
	createdAt: z.string(),
	category: z.string(),
	text: z.string(),
	relevance: z.number(),
});

server.registerTool(
	"what_changed",
	{
		description: "Show active memories created or materially updated since an ISO timestamp.",
		inputSchema: z.object({
			since: z.string(),
			limit: z.number().int().min(1).max(100).default(25),
			categories: z.array(z.enum(CATEGORIES)).optional(),
		}),
		outputSchema: z.object({
			since: z.string(),
			generated_at: z.string(),
			counts: z.object({ created: z.number().int(), updated: z.number().int() }),
			changes: z.array(memoryChangeSchema),
		}),
	},
	handlers.whatChanged,
);

server.registerTool(
	"topic_digest",
	{
		description: "Summarize recent memories relevant to a topic with supporting memory IDs.",
		inputSchema: z.object({
			topic: z.string().trim().min(1),
			days: z.number().int().min(1).max(365).default(14),
			max_sources: z.number().int().min(1).max(30).default(12),
			include_decisions: z.boolean().default(true),
		}),
		outputSchema: z.object({
			topic: z.string(),
			window: z.object({ start: z.string(), end: z.string(), days: z.number().int() }),
			digest: z.string(),
			sources: z.array(digestSourceSchema),
		}),
	},
	handlers.topicDigest,
);
```

- [ ] **Step 6: Wire the module into MCP initialization**

In `src/mcp.ts`:

```ts
import { registerDailyRecallTools } from "./tools/daily-recall";
```

Call it immediately after the base memory tools:

```ts
registerMemoryTools(this.server, env, userId);
registerDailyRecallTools(this.server, env, userId);
```

- [ ] **Step 7: Update the surface guard**

In `scripts/check-tool-surface.mjs`, add `"src/tools/daily-recall.ts"` to `activeFiles` after memory tools and change:

```js
const EXPECTED_TOOLS = 139;
```

- [ ] **Step 8: Run focused and surface tests**

Run:

```bash
node --import tsx --test tests/daily-recall.test.ts tests/daily-recall-tools.test.ts
npm run test:surface
```

Expected:

```text
Tool surface verified: 139 tools
```

and all focused tests pass.

- [ ] **Step 9: Commit the complete tool surface**

```bash
git add src/tools/daily-recall.ts tests/daily-recall-tools.test.ts src/mcp.ts scripts/check-tool-surface.mjs
git commit -m "feat: add daily recall MCP tools"
```

### Task 6: Full verification and deployment-shaped gate

**Files:**
- No production file changes expected.
- Generated dry-run output: `/tmp/mcp-memory-daily-recall-dry-run`

**Interfaces:**
- Consumes: the four completed tools and repository test surface.
- Produces: verified local implementation and a deployable Worker bundle.

- [ ] **Step 1: Run formatting checks without rewriting unrelated files**

Run:

```bash
npx biome check src/utils/daily-recall.ts src/tools/daily-recall.ts tests/daily-recall.test.ts tests/daily-recall-tools.test.ts src/utils/tool-result.ts tests/tool-result.test.ts src/utils/db.ts tests/db.test.ts src/mcp.ts scripts/check-tool-surface.mjs
```

Expected: no diagnostics. If formatting is required, run `npx biome format --write` only on the listed files and commit the formatting with the owning task’s files.

- [ ] **Step 2: Run the complete test suite**

Run:

```bash
npm test
```

Expected: exit 0, no test failures.

- [ ] **Step 3: Verify the tool surface**

Run:

```bash
npm run test:surface
```

Expected:

```text
Tool surface verified: 139 tools
```

- [ ] **Step 4: Run the TypeScript compiler gate**

Run:

```bash
npx tsc --noEmit
```

Expected: exit 0 with no diagnostics.

- [ ] **Step 5: Build the Cloudflare deployment bundle without publishing**

Run:

```bash
npx wrangler deploy --dry-run --outdir /tmp/mcp-memory-daily-recall-dry-run
```

Expected: Worker bundle completes successfully and includes no missing dependency or binding errors.

- [ ] **Step 6: Inspect the final diff without touching unrelated work**

Run:

```bash
git diff --check HEAD^ HEAD
git status --short
```

Expected: the Daily Recall commits contain only the files named in this plan. The pre-existing prompt-engineering and routing changes remain present and unmodified unless they were independently committed by their owner.

### Task 7: Production deployment and live MCP validation

**Files:**
- No source changes expected.

**Interfaces:**
- Consumes: verified Worker bundle and authenticated Cloudflare environment.
- Produces: a deployed Worker version and four live tool-call results.

- [ ] **Step 1: Confirm the transport is healthy before deployment**

Probe the configured SSE route and verify it returns `200` with `content-type: text/event-stream`. Do not treat HTML or an Access redirect as healthy.

- [ ] **Step 2: Deploy the verified source state**

Run:

```bash
npx wrangler deploy
```

Expected: Wrangler reports a successful Worker version deployment.

- [ ] **Step 3: Verify read-only tools live**

Call:

```text
what_changed({ since: "2026-07-24T00:00:00.000Z", limit: 5 })
topic_digest({ topic: "MCP memory", days: 30, max_sources: 5, include_decisions: true })
recall_decisions({ project: "MCP Memory", limit: 5 })
```

Expected: each result contains readable `content`, valid `structuredContent`, and no HTML/transport error.

- [ ] **Step 4: Verify the write tool with disposable content**

Call:

```text
remember_decision({
  decision: "Disposable Daily Recall validation record",
  rationale: "Verifies the live tool contract.",
  project: "MCP Memory Validation",
  alternatives: ["Skip live write validation"],
  tags: ["validation"]
})
```

Capture the returned memory ID, verify it appears through `recall_decisions`, then delete it with the existing `forget_memory` tool.

- [ ] **Step 5: Record deployment evidence**

Report the deployed Worker version, the four live call outcomes, disposable-record cleanup result, and any remaining Access or connector limitation. Do not claim completion if the live connector still returns HTML or cannot initialize.
