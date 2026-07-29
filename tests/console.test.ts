import assert from "node:assert/strict";
import test from "node:test";
import {
	filterMemories,
	memoryRoute,
	requiresDeleteConfirmation,
} from "../static/console.mjs";

const memories = [
	{
		id: "a",
		content: "Prefer concise technical notes",
		category: "preference",
		layer: "core",
		tags: ["writing"],
		pinned: true,
	},
	{
		id: "b",
		content: "Complete project review",
		category: "task",
		layer: "current",
		tags: ["planning"],
		pinned: false,
	},
];

test("filters only loaded tenant records by text, category, and layer", () => {
	assert.deepEqual(
		filterMemories(memories, { query: "technical", category: "", layer: "" }).map(
			(memory) => memory.id,
		),
		["a"],
	);
	assert.deepEqual(
		filterMemories(memories, { query: "", category: "task", layer: "current" }).map(
			(memory) => memory.id,
		),
		["b"],
	);
	assert.deepEqual(
		filterMemories(memories, { query: "", category: "preference", layer: "current" }),
		[],
	);
});

test("builds encoded same-origin tenant routes", () => {
	assert.equal(memoryRoute("tenant/one", "memories"), "/tenant%2Fone/memories");
	assert.equal(
		memoryRoute("tenant one", "memories", "memory/one"),
		"/tenant%20one/memories/memory%2Fone",
	);
});

test("requires the selected memory ID before allowing delete", () => {
	assert.equal(requiresDeleteConfirmation("memory-42", "memory-42"), true);
	assert.equal(requiresDeleteConfirmation("memory-42", "MEMORY-42"), false);
	assert.equal(requiresDeleteConfirmation("memory-42", ""), false);
});
