import assert from "node:assert/strict";
import test from "node:test";

import type { Memory } from "../src/types";
import {
	buildDecisionRecord,
	classifyMemoryChanges,
	digestHasValidCitations,
	parseIsoTimestamp,
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

test("parseIsoTimestamp accepts complete ISO timestamps and canonicalizes milliseconds", () => {
	assert.equal(parseIsoTimestamp("2026-07-24T02:00:00.1Z", "tested_at"), "2026-07-24T02:00:00.100Z");
});

test("parseIsoTimestamp rejects non-ISO and normalized invalid calendar dates", () => {
	assert.throws(() => parseIsoTimestamp("2026/07/24 02:00:00", "tested_at"), /tested_at must be a valid ISO timestamp/);
	assert.throws(() => parseIsoTimestamp("2026-02-30T02:00:00.000Z", "tested_at"), /tested_at must be a valid ISO timestamp/);
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

test("classifyMemoryChanges filters suppressed and unwanted categories and bounds limits", () => {
	const memories = [
		baseMemory({ id: "allowed", updated_at: "2026-07-24T03:00:00.000Z" }),
		baseMemory({ id: "suppressed", suppressed: true, updated_at: "2026-07-24T02:00:00.000Z" }),
		baseMemory({ id: "other", category: "goals", updated_at: "2026-07-24T01:00:00.000Z" }),
	];
	assert.deepEqual(
		classifyMemoryChanges(memories, "2026-07-24T00:00:00.000Z", ["projects"], 1.9).map((change) => change.id),
		["allowed"],
	);
	assert.deepEqual(classifyMemoryChanges(memories, "2026-07-24T00:00:00.000Z", undefined, 0), []);
	assert.deepEqual(classifyMemoryChanges(memories, "2026-07-24T00:00:00.000Z", undefined, -1), []);
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

test("rankDigestSources bounds zero, negative, and fractional source limits", () => {
	const candidates = [
		{ memory: baseMemory({ id: "a" }), relevance: 0.9 },
		{ memory: baseMemory({ id: "b", created_at: "2026-07-23T00:00:00.000Z" }), relevance: 0.8 },
	];
	assert.deepEqual(rankDigestSources(candidates, "2026-07-24T04:00:00.000Z", 0), []);
	assert.deepEqual(rankDigestSources(candidates, "2026-07-24T04:00:00.000Z", -1), []);
	assert.deepEqual(rankDigestSources(candidates, "2026-07-24T04:00:00.000Z", 1.9).map((source) => source.id), ["a"]);
});

test("rankDigestSources canonicalizes timestamps before choosing the effective recency", () => {
	const ranked = rankDigestSources(
		[
			{
				memory: baseMemory({
					id: "a",
					created_at: "2026-07-24T00:00:00.000+10:00",
					updated_at: "2026-07-23T16:00:00.000Z",
				}),
				relevance: 0.9,
			},
			{
				memory: baseMemory({ id: "b", created_at: "2026-07-23T15:00:00.000Z", updated_at: "2026-07-23T15:00:00.000Z" }),
				relevance: 0.9,
			},
		],
		"2026-07-23T17:00:00.000Z",
		2,
	);
	assert.deepEqual(ranked.map((source) => source.id), ["a", "b"]);
});

test("rankDigestSources rejects malformed source timestamps deterministically", () => {
	assert.throws(
		() => rankDigestSources([{ memory: baseMemory({ created_at: "not-a-timestamp" }), relevance: 0.9 }], "2026-07-24T04:00:00.000Z", 1),
		/created_at must be a valid ISO timestamp/,
	);
	assert.throws(
		() => rankDigestSources([{ memory: baseMemory({ updated_at: "2026-02-30T00:00:00.000Z" }), relevance: 0.9 }], "2026-07-24T04:00:00.000Z", 1),
		/updated_at must be a valid ISO timestamp/,
	);
});

test("renderExtractiveDigest restores the bracketed ID citation contract", () => {
	const text = renderExtractiveDigest("MCP memory", [
		{ id: "a", createdAt: "2026-07-24T00:00:00.000Z", category: "projects", text: "Added daily recall.", relevance: 0.9 },
	]);
	assert.equal(text, "- [a] Added daily recall.");
	assert.equal(digestHasValidCitations("Added daily recall [a].", [{ id: "a", createdAt: "2026-07-24T00:00:00.000Z", category: "projects", text: "Added daily recall.", relevance: 0.9 }]), true);
});

test("renderExtractiveDigest escapes source brackets without treating them as citations", () => {
	const text = renderExtractiveDigest("MCP memory", [
		{ id: "a", createdAt: "2026-07-24T00:00:00.000Z", category: "projects", text: "Added [context].", relevance: 0.9 },
	]);
	assert.equal(text, "- [a] Added \\[context\\].");
	assert.equal(digestHasValidCitations(text, [{ id: "a", createdAt: "2026-07-24T00:00:00.000Z", category: "projects", text: "Added [context].", relevance: 0.9 }]), true);
});

test("renderExtractiveDigest encodes unsafe source IDs consistently", () => {
	const sources = [{ id: "a [draft]", createdAt: "2026-07-24T00:00:00.000Z", category: "projects", text: "Added daily recall.", relevance: 0.9 }];
	const text = renderExtractiveDigest("MCP memory", sources);
	assert.equal(text, "- [a%20%5Bdraft%5D] Added daily recall.");
	assert.equal(digestHasValidCitations(text, sources), true);
});

test("digestHasValidCitations rejects missing and unknown source IDs", () => {
	const sources = [
		{ id: "a", createdAt: "2026-07-24T00:00:00.000Z", category: "projects", text: "Added daily recall.", relevance: 0.9 },
	];
	assert.equal(digestHasValidCitations("Added daily recall.", sources), false);
	assert.equal(digestHasValidCitations("Added daily recall [other].", sources), false);
	assert.equal(digestHasValidCitations("Added daily recall [a].", sources), true);
});
