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
	assert.match(
		calls[0].sql,
		/julianday\(created_at\)>=julianday\(\?\) OR julianday\(updated_at\)>=julianday\(\?\)/,
	);
	assert.match(calls[0].sql, /LIMIT \?/);
	assert.deepEqual(calls[0].values, [
		"u1",
		"2026-07-24T00:00:00.000Z",
		"2026-07-24T00:00:00.000Z",
		25,
	]);
});

test("queryMemoryChanges binds validated categories before its ordered candidate limit", async () => {
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

	await queryMemoryChanges("u1", "2026-07-24T00:00:00.000Z", env, 25, [
		"projects",
		"projects",
		"goals",
	]);

	const sql = calls[0].sql.replace(/\s+/g, " ");
	assert.match(sql, /AND category IN \(\?, \?\) ORDER BY CASE/);
	assert.deepEqual(calls[0].values, [
		"u1",
		"2026-07-24T00:00:00.000Z",
		"2026-07-24T00:00:00.000Z",
		"projects",
		"goals",
		25,
	]);
});

test("queryMemoriesWithAllTags intersects every tag before ordering and limiting", async () => {
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
	const { queryMemoriesWithAllTags } = await import("../src/utils/db");

	await queryMemoriesWithAllTags("u1", ["decision", "project:mcp-memory"], env, 50, {
		createdAt: "2026-07-24T00:00:00.000Z",
		id: "cursor-id",
	});

	const sql = calls[0].sql.replace(/\s+/g, " ");
	assert.match(
		sql,
		/tags LIKE \? AND tags LIKE \? AND \(created_at < \? OR created_at IS NULL OR \(created_at = \? AND id > \?\)\) ORDER BY created_at DESC, id ASC LIMIT \?/,
	);
	assert.deepEqual(calls[0].values, [
		"u1",
		'%"decision"%',
		'%"project:mcp-memory"%',
		"2026-07-24T00:00:00.000Z",
		"2026-07-24T00:00:00.000Z",
		"cursor-id",
		50,
	]);

	await queryMemoriesWithAllTags("u1", ["decision"], env, 50, {
		createdAt: null,
		id: "null-cursor",
	});
	const nullCursorSql = calls[1].sql.replace(/\s+/g, " ");
	assert.match(
		nullCursorSql,
		/tags LIKE \? AND \(created_at IS NULL AND id > \?\) ORDER BY created_at DESC, id ASC LIMIT \?/,
	);
	assert.deepEqual(calls[1].values, ["u1", '%"decision"%', "null-cursor", 50]);
});

test("queryMemoryChanges normalizes limits and uses deterministic null-safe timestamps", async () => {
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

	for (const [limit, expected] of [
		[0, 1],
		[-5, 1],
		[25.9, 25],
		[101, 100],
		[Number.NaN, 100],
		[Number.POSITIVE_INFINITY, 100],
		[Number.NEGATIVE_INFINITY, 100],
	]) {
		await queryMemoryChanges("u1", "2026-07-24T00:00:00.000Z", env, limit);
		const boundLimit = calls.at(-1)?.values[3];
		assert.equal(boundLimit, expected);
		assert.ok(Number.isInteger(boundLimit));
		assert.ok((boundLimit as number) >= 1 && (boundLimit as number) <= 100);
	}

	const sql = calls[0].sql.replace(/\s+/g, " ");
	assert.match(
		sql,
		/julianday\(created_at\)>=julianday\(\?\) OR julianday\(updated_at\)>=julianday\(\?\)/,
	);
	assert.match(sql, /WHEN julianday\(updated_at\) IS NULL THEN julianday\(created_at\)/);
	assert.match(sql, /WHEN julianday\(created_at\) IS NULL THEN julianday\(updated_at\)/);
	assert.match(sql, /ORDER BY CASE .* END DESC, id ASC/);
});
