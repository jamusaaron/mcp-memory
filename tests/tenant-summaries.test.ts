import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app";
import * as db from "../src/utils/db";
import { insertMemory } from "../src/utils/db";
import { createSqliteD1Harness, initializeSqliteD1 } from "./helpers/sqlite-d1";

type TenantSummary = {
	id: string;
	memoryCount: number;
	lastUpdated: string | null;
};

type TenantSummaryDb = typeof db & {
	listTenantSummaries?: (env: Env, limit?: number) => Promise<TenantSummary[]>;
};

test("returns every known tenant summary without memory content", async () => {
	let sql = "";
	let boundLimit: unknown;
	const env = {
		DB: {
			prepare(statement: string) {
				sql = statement;
				const result = {
					all: async () => ({
						results: [
							{
								id: "tenant-b",
								memoryCount: 2,
								lastUpdated: "2026-07-30T00:00:00.000Z",
							},
						],
					}),
				};
				return {
					bind(limit: unknown) {
						boundLimit = limit;
						return result;
					},
					...result,
				};
			},
		},
	} as unknown as Env;

	const listTenantSummaries = (db as TenantSummaryDb).listTenantSummaries;
	assert.equal(
		typeof listTenantSummaries,
		"function",
		"tenant discovery must provide a summary query",
	);
	if (typeof listTenantSummaries !== "function") return;

	assert.deepEqual(await listTenantSummaries(env), [
		{ id: "tenant-b", memoryCount: 2, lastUpdated: "2026-07-30T00:00:00.000Z" },
	]);
	assert.equal(boundLimit, undefined);
	assert.match(sql, /WITH known_tenants AS/i);
	assert.match(sql, /UNION\s+SELECT userId FROM derived_artifacts/i);
	assert.match(sql, /COALESCE\(memory_summary\.memoryCount, 0\)/i);
	assert.match(sql, /COUNT\(\*\) AS memoryCount/);
	assert.doesNotMatch(sql, /\btext\b|\bcontent\b|\bvalue\b/i);
});

test("lists a known tenant even when it has no memory rows", async (t) => {
	const harness = createSqliteD1Harness();
	t.after(() => harness.close());
	await initializeSqliteD1(harness.env);
	await insertMemory({ userId: "tenant-with-memory", text: "A private memory" }, harness.env);
	await harness.env.DB.prepare(
		"INSERT INTO people (id,userId,name) VALUES (?,?,?)",
	)
		.bind("person-without-memory", "tenant-with-profile", "Private person")
		.run();

	const listTenantSummaries = (db as TenantSummaryDb).listTenantSummaries;
	assert.equal(typeof listTenantSummaries, "function");
	if (typeof listTenantSummaries !== "function") return;

	assert.deepEqual(await listTenantSummaries(harness.env), [
		{
			id: "tenant-with-memory",
			memoryCount: 1,
			lastUpdated: (await listTenantSummaries(harness.env))[0]?.lastUpdated,
		},
		{ id: "tenant-with-profile", memoryCount: 0, lastUpdated: null },
	]);
});

test("returns tenant summaries only to an authenticated console request", async (t) => {
	const harness = createSqliteD1Harness();
	t.after(() => harness.close());
	Object.assign(harness.env, {
		APP_ACCESS_KEY: "private-access-key",
		COOKIE_ENCRYPTION_KEY: "cookie-signing-key",
		RATE_LIMITER: { limit: async () => ({ success: true }) },
	});
	await initializeSqliteD1(harness.env);
	await insertMemory({ userId: "tenant-a", text: "Private memory content" }, harness.env);
	await insertMemory({ userId: "tenant-a", text: "Another private memory" }, harness.env);

	const app = createApp(async () => new Response("unexpected MCP response", { status: 404 }));
	const response = await app.fetch(
		new Request("https://example.test/tenants", {
			headers: { Accept: "application/json", Authorization: "Bearer private-access-key" },
		}),
		harness.env,
		{} as ExecutionContext,
	);

	assert.equal(response.status, 200);
	const body = (await response.json()) as {
		success: boolean;
		tenants: TenantSummary[];
	};
	assert.equal(body.success, true);
	assert.deepEqual(body.tenants.map(({ id, memoryCount }) => ({ id, memoryCount })), [
		{ id: "tenant-a", memoryCount: 2 },
	]);
	assert.equal(typeof body.tenants[0]?.lastUpdated, "string");
	assert.deepEqual(Object.keys(body.tenants[0] ?? {}).sort(), ["id", "lastUpdated", "memoryCount"]);
});
