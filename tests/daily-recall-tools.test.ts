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
