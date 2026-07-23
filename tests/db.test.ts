import assert from "node:assert/strict";
import test from "node:test";

import { deleteMemory, updateMemory } from "../src/utils/db";

function envWithChanges(changes: number): Env {
	const statement = {
		bind() {
			return this;
		},
		async run() {
			return { meta: { changes } };
		},
	};

	return {
		DB: {
			prepare() {
				return statement;
			},
		},
	} as unknown as Env;
}

test("updateMemory rejects when the memory does not exist", async () => {
	await assert.rejects(
		updateMemory("missing-id", "user-id", { subject: "test" }, envWithChanges(0)),
		/Memory missing-id not found/,
	);
});

test("deleteMemory rejects when the memory does not exist", async () => {
	await assert.rejects(
		deleteMemory("missing-id", "user-id", envWithChanges(0)),
		/Memory missing-id not found/,
	);
});

test("memory mutations resolve when one row changes", async () => {
	const env = envWithChanges(1);
	await updateMemory("existing-id", "user-id", { subject: "test" }, env);
	await deleteMemory("existing-id", "user-id", env);
});

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
