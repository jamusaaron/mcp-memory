import assert from "node:assert/strict";
import test from "node:test";
import * as consoleWorkspace from "../static/console.mjs";
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

test("labels selectable tenant options with their memory counts", () => {
	const tenantOptionLabel = consoleWorkspace.tenantOptionLabel;
	assert.equal(typeof tenantOptionLabel, "function", "the console must format tenant choices");
	if (typeof tenantOptionLabel !== "function") return;

	assert.equal(
		tenantOptionLabel({ id: "tenant-a", memoryCount: 1 }),
		"tenant-a — 1 memory",
	);
	assert.equal(
		tenantOptionLabel({ id: "tenant-b", memoryCount: 2 }),
		"tenant-b — 2 memories",
	);
});

test("labels the complete known-tenant count for the selector", () => {
	const tenantPickerSummary = consoleWorkspace.tenantPickerSummary;
	assert.equal(typeof tenantPickerSummary, "function", "the console must describe known tenants");
	if (typeof tenantPickerSummary !== "function") return;

	assert.equal(tenantPickerSummary(1), "1 known tenant");
	assert.equal(tenantPickerSummary(4), "4 known tenants");
});

test("uses manual tenant entry in preference to a selected discovery result", () => {
	const selectedTenantId = consoleWorkspace.selectedTenantId;
	assert.equal(typeof selectedTenantId, "function", "the console must keep manual tenant entry");
	if (typeof selectedTenantId !== "function") return;

	assert.equal(selectedTenantId("tenant-a", ""), "tenant-a");
	assert.equal(selectedTenantId("tenant-a", "  tenant-manual  "), "tenant-manual");
});
