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
				id: "id" in input && typeof input.id === "string" ? input.id : `decision-${stored.length + 1}`,
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

test("recallDecisions never returns suppressed tagged or semantic decisions", async () => {
	const { stored, deps } = harness();
	const handlers = createDailyRecallHandlers("u1", {} as Env, deps);
	await handlers.rememberDecision({ decision: "Ship daily tools", project: "MCP Memory" });
	const decision = stored[0];
	const taggedSuppressed = { ...decision, id: "tagged-suppressed", suppressed: true };
	const semanticSuppressed = { ...decision, id: "semantic-suppressed", suppressed: true };
	stored.push(semanticSuppressed);
	deps.queryMemoriesByTags = async () => [decision, taggedSuppressed];
	deps.searchMemories = async () => [
		{ id: decision.id, content: decision.text, score: 0.92 },
		{ id: semanticSuppressed.id, content: semanticSuppressed.text, score: 0.91 },
	];

	const result = await handlers.recallDecisions({ query: "daily tools", limit: 10 });
	const data = structured<{ count: number; decisions: Array<{ id: string }> }>(result);
	assert.equal(data.count, 1);
	assert.deepEqual(data.decisions.map((item) => item.id), ["decision-1"]);
});

test("recallDecisions defaults a direct omitted limit to ten", async () => {
	const { deps } = harness();
	const handlers = createDailyRecallHandlers("u1", {} as Env, deps);
	for (let index = 0; index < 11; index += 1) {
		await handlers.rememberDecision({ decision: `Decision ${index}` });
	}

	const result = await handlers.recallDecisions({});
	const data = structured<{ count: number }>(result);
	assert.equal(data.count, 10);
});

test("recallDecisions rejects a direct negative limit", async () => {
	const { deps } = harness();
	const handlers = createDailyRecallHandlers("u1", {} as Env, deps);
	const result = await handlers.recallDecisions({ limit: -1 });
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /limit must be an integer from 1 to 50/);
});

test("recallDecisions rejects a direct oversized limit", async () => {
	const { deps } = harness();
	const handlers = createDailyRecallHandlers("u1", {} as Env, deps);
	const result = await handlers.recallDecisions({ limit: 51 });
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /limit must be an integer from 1 to 50/);
});

test("recallDecisions rejects a direct fractional limit", async () => {
	const { deps } = harness();
	const handlers = createDailyRecallHandlers("u1", {} as Env, deps);
	const result = await handlers.recallDecisions({ limit: 1.5 });
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /limit must be an integer from 1 to 50/);
});

test("recallDecisions requires paired dates for direct calls", async () => {
	const { deps } = harness();
	const handlers = createDailyRecallHandlers("u1", {} as Env, deps);
	const result = await handlers.recallDecisions({ start_date: "2026-07-24T00:00:00Z" });
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /start_date and end_date must be supplied together/);
});

test("recallDecisions orders equal-date and equal-score decisions by ascending id", async () => {
	async function recalledIds(reverse: boolean) {
		const { stored, deps } = harness();
		const handlers = createDailyRecallHandlers("u1", {} as Env, deps);
		for (const decision of ["First decision", "Second decision"]) {
			await handlers.rememberDecision({
				decision,
				decided_at: "2026-07-23T00:00:00.000Z",
			});
		}
		const memories = reverse ? [...stored].reverse() : stored;
		deps.queryMemoriesByTags = async () => memories;
		deps.searchMemories = async () =>
			memories.map((memory) => ({ id: memory.id, content: memory.text, score: 0.91 }));
		const result = await handlers.recallDecisions({ query: "decision", limit: 10 });
		return structured<{ decisions: Array<{ id: string }> }>(result).decisions.map((item) => item.id);
	}

	assert.deepEqual(await recalledIds(false), ["decision-1", "decision-2"]);
	assert.deepEqual(await recalledIds(true), ["decision-1", "decision-2"]);
});

test("rememberDecision keeps durable metadata when vector storage fails", async () => {
	const { stored, deps } = harness();
	deps.storeMemoryVector = async () => {
		throw new Error("Vectorize unavailable");
	};
	const handlers = createDailyRecallHandlers("u1", {} as Env, deps);
	const result = await handlers.rememberDecision({ decision: "Store without a vector" });
	const data = structured<{ embedding_status: string }>(result);
	assert.equal(data.embedding_status, "pending");
	assert.equal(stored.length, 1);
	assert.equal(stored[0].category, "projects");
	assert.equal(stored[0].layer, "long_embedded");
	assert.equal(stored[0].embedding_status, "pending");
});

test("rememberDecision keeps durable metadata when embedding-status update fails", async () => {
	const { stored, deps } = harness();
	deps.updateMemory = async () => {
		throw new Error("Database unavailable");
	};
	const handlers = createDailyRecallHandlers("u1", {} as Env, deps);
	const result = await handlers.rememberDecision({ decision: "Keep durable metadata" });
	const data = structured<{ embedding_status: string }>(result);
	assert.equal(data.embedding_status, "pending");
	assert.equal(stored.length, 1);
	assert.equal(stored[0].category, "projects");
	assert.equal(stored[0].layer, "long_embedded");
	assert.equal(stored[0].embedding_status, "pending");
});

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

test("topicDigest bounds vector hits, hydrations, sources, and model context", async () => {
	const { deps } = harness();
	const source = await deps.insertMemory(
		{ id: "source-1", userId: "u1", text: "x".repeat(10_000), category: "projects" },
		{} as Env,
	);
	let requestedHits = 0;
	let hydrated = 0;
	let modelContext = "";
	deps.searchMemories = async (_query, _userId, _env, limit) => {
		requestedHits = limit;
		return Array.from({ length: 200 }, () => ({ id: source.id, content: source.text, score: 0.94 }));
	};
	deps.getMemoryById = async () => {
		hydrated += 1;
		return source;
	};
	deps.callModel = async (_system, user) => {
		modelContext = user;
		return `[${source.id}] concise`;
	};
	const handlers = createDailyRecallHandlers("u1", {} as Env, deps);
	const result = await handlers.topicDigest({
		topic: "daily tools",
		days: 14,
		max_sources: 30,
		include_decisions: true,
	});
	const data = structured<{ sources: Array<{ id: string; text: string }> }>(result);
	assert.equal(requestedHits, 90);
	assert.ok(hydrated <= 90);
	assert.equal(data.sources.length, 1);
	assert.equal(data.sources[0].text.length, 4_000);
	assert.ok(modelContext.length < 5_000);
});

test("topicDigest rejects direct oversized source limits before querying", async () => {
	const { deps } = harness();
	let queried = false;
	deps.searchMemories = async () => {
		queried = true;
		return [];
	};
	const handlers = createDailyRecallHandlers("u1", {} as Env, deps);
	const result = await handlers.topicDigest({
		topic: "daily tools",
		days: 14,
		max_sources: 31,
		include_decisions: true,
	});
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /max_sources must be an integer from 1 to 30/);
	assert.equal(queried, false);
});
