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
	assert.match(result.text, /^Alternatives:\n- One mega tool\n- No change$/m);
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
