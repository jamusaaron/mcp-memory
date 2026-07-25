import assert from "node:assert/strict";
import test from "node:test";

import {
	runScheduledMaintenance,
	type MaintenanceDependencies,
} from "../src/maintenance";
import {
	artifactRetryDelayMs,
	createD1ArtifactStore,
	listDueLivingSummaryTenants,
	recordArtifactRebuildFailure,
} from "../src/utils/artifact-store";
import type { ArtifactRebuildState } from "../src/types";
import { initializeDatabase } from "../src/schema";
import {
	createSqliteD1,
	initializeSqliteD1,
} from "./helpers/sqlite-d1";

const NOW = new Date("2026-07-24T06:00:00.000Z");

function memoryRow(
	userId: string,
	id: string,
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		id,
		userId,
		category: "knowledge",
		layer: "current",
		subject: null,
		text: "bounded maintenance fixture",
		tags: "[]",
		triggers: "[]",
		confidence: 0.8,
		salience: 0.5,
		emotion_weight: 0,
		source_type: "stated",
		linked_people: "[]",
		embedding_status: "pending",
		suppressed: 0,
		suppression_reason: null,
		pinned: 0,
		access_count: 0,
		created_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

function insertRow(
	DB: ReturnType<typeof createSqliteD1>,
	table: string,
	row: Record<string, unknown>,
): void {
	const columns = Object.keys(row);
	DB.raw
		.prepare(
			`INSERT INTO ${table} (${columns.join(",")})
			 VALUES (${columns.map(() => "?").join(",")})`,
		)
		.run(...(Object.values(row) as never[]));
}

function publishedLivingSummaryRow(
	userId: string,
	id: string,
): Record<string, unknown> {
	return {
		id,
		userId,
		kind: "living_summary",
		version: 1,
		status: "published",
		validation_state: "validated",
		content_json: JSON.stringify({ claims: [] }),
		rendered_text: "current",
		source_watermark: "watermark",
		evidence_generation: 0,
		eligible_source_count: 1,
		selected_source_count: 1,
		source_truncated: 0,
		content_sha256: "sha",
		model: "test-model",
		prompt_version: "trusted-artifacts-v1",
		validation_json: "{}",
		created_at: "2026-07-01T00:00:00.000Z",
		published_at: "2026-07-01T00:00:00.000Z",
	};
}

function dependencies(overrides: Partial<MaintenanceDependencies> = {}): {
	deps: MaintenanceDependencies;
	rebuilds: string[];
	logs: Array<Record<string, unknown>>;
} {
	const rebuilds: string[] = [];
	const logs: Array<Record<string, unknown>> = [];
	const deps: MaintenanceDependencies = {
		now: () => NOW,
		monotonicNowMs: () => 0,
		initializeDatabase: async () => ({
			ready: true,
			changed: false,
			queryCount: 2,
		}),
		readLegacyMaintenanceCursor: async () => null,
		writeLegacyMaintenanceCursor: async () => {},
		listActiveUserIds: async () => [],
		getUnembeddedMemories: async () => [],
		storeMemoryVector: async () => {},
		updateMemory: async () => {},
		queryMemories: async () => [],
		purgeDueArtifactCaches: async () => ({
			attempted: 0,
			purged: 0,
			failed: 0,
		}),
		listDueLivingSummaryTenants: async () => [],
		rebuildDerivedArtifact: async (userId, kind) => {
			assert.equal(kind, "living_summary");
			rebuilds.push(userId);
			return {
				artifact: { id: `artifact-${userId}` } as never,
				reused: false,
				published: true,
			};
		},
		log: (entry) => logs.push(entry),
		...overrides,
	};
	return { deps, rebuilds, logs };
}

test("calculates exponential backoff from 30 minutes through the 24-hour cap", () => {
	assert.deepEqual(
		[1, 2, 3, 4, 5, 6, 7, 8].map(artifactRetryDelayMs),
		[
			30 * 60_000,
			60 * 60_000,
			120 * 60_000,
			240 * 60_000,
			480 * 60_000,
			960 * 60_000,
			1_440 * 60_000,
			1_440 * 60_000,
		],
	);
});

test("failure state persists without an artifact row and caps repeated retries", async () => {
	const DB = createSqliteD1();
	const env = { DB } as Env;
	await initializeSqliteD1(env);

	await recordArtifactRebuildFailure(
		"tenant-a",
		"living_summary",
		"generation_failed",
		NOW,
		env,
	);
	await recordArtifactRebuildFailure(
		"tenant-a",
		"living_summary",
		"generation_failed",
		NOW,
		env,
	);
	const state = await DB.prepare(
		`SELECT userId,kind,retry_count,next_retry_at,last_error_code,
		        operation_id,updated_at
		 FROM derived_artifact_rebuild_state
		 WHERE userId=? AND kind='living_summary'`,
	)
		.bind("tenant-a")
		.first<ArtifactRebuildState>();
	assert.equal(state?.retry_count, 2);
	assert.equal(state?.next_retry_at, "2026-07-24T07:00:00.000Z");
	assert.equal(state?.last_error_code, "generation_failed");
	assert.ok(state?.operation_id);
	const eventCount = await DB.prepare(
		`SELECT COUNT(*) AS count
		 FROM derived_artifact_events
		 WHERE userId=? AND kind='living_summary' AND event_type='generation_failed'`,
	)
		.bind("tenant-a")
		.first<{ count: number }>();
	assert.equal(eventCount?.count, 2);
	DB.close();
});

test("due selection filters to missing or stale summaries whose retry time has arrived", async () => {
	const calls: Array<{ sql: string; values: unknown[] }> = [];
	const env = {
		DB: {
			prepare(sql: string) {
				return {
					bind(...values: unknown[]) {
						calls.push({ sql, values });
						return {
							all: async () => ({
								results: [{ userId: "tenant-a" }],
							}),
						};
					},
				};
			},
		},
	} as unknown as Env;
	const due = await listDueLivingSummaryTenants(env, 50, NOW.toISOString());
	assert.deepEqual(due, ["tenant-a"]);
	const sql = calls[0].sql.replace(/\s+/g, " ");
	assert.match(sql, /active.kind='living_summary'/);
	assert.match(sql, /active.status IN \('published','stale'\)/);
	assert.match(sql, /active.id IS NULL OR active.status='stale'/);
	assert.match(sql, /rebuild.next_retry_at IS NULL OR rebuild.next_retry_at<=\?/);
	assert.match(sql, /ORDER BY COALESCE\(rebuild.next_retry_at, ''\) ASC, tenants.userId ASC/);
	assert.match(sql, /LIMIT \?/);
	assert.deepEqual(calls[0].values, [NOW.toISOString(), 1]);
});

test("rebuild phase selects and processes at most one tenant", async () => {
	const { deps, rebuilds } = dependencies({
		listDueLivingSummaryTenants: async () => ["tenant-1", "tenant-2"],
		listActiveUserIds: async () => {
			throw new Error("legacy phase must not run");
		},
	});
	await runScheduledMaintenance({} as Env, deps);
	assert.deepEqual(rebuilds, ["tenant-1"]);
});

test("passes a one-tenant bound and current time into due selection", async () => {
	const selections: Array<{ now: string; limit: number }> = [];
	const { deps } = dependencies({
		listDueLivingSummaryTenants: async (_env, limit, now) => {
			selections.push({ now, limit });
			return [];
		},
	});
	await runScheduledMaintenance({} as Env, deps);
	assert.deepEqual(selections, [{ now: NOW.toISOString(), limit: 1 }]);
});

test("attempted purge work ends the invocation before rebuild selection", async () => {
	const order: string[] = [];
	const { deps } = dependencies({
		purgeDueArtifactCaches: async (_env, limit, now) => {
			order.push(`purge:${limit}:${now.toISOString()}`);
			return { attempted: 1, purged: 0, failed: 1 };
		},
		listDueLivingSummaryTenants: async () => {
			throw new Error("rebuild phase must not run");
		},
	});
	await runScheduledMaintenance({} as Env, deps);
	assert.deepEqual(order, [`purge:10:${NOW.toISOString()}`]);
});

test("schema advancement or incomplete state ends the invocation", async () => {
	for (const initialization of [
		{ ready: false, changed: true, queryCount: 37 },
		{ ready: true, changed: true, queryCount: 18 },
	]) {
		let purgeCalls = 0;
		const { deps, logs } = dependencies({
			initializeDatabase: async () => initialization,
			purgeDueArtifactCaches: async () => {
				purgeCalls += 1;
				return { attempted: 0, purged: 0, failed: 0 };
			},
		});
		await runScheduledMaintenance({} as Env, deps);
		assert.equal(purgeCalls, 0);
		assert.ok(logs.some((entry) => entry.phase === "schema"));
	}
});

test("stable schema contributes exactly two statements to the cron budget", async () => {
	const { deps } = dependencies({
		initializeDatabase: async () => ({
			ready: true,
			changed: false,
			queryCount: 2,
		}),
	});
	await runScheduledMaintenance({} as Env, deps);
});

test("logs only bounded reason codes and tenant-safe hashes", async () => {
	const { deps, logs } = dependencies({
		listDueLivingSummaryTenants: async () => ["tenant-private"],
		rebuildDerivedArtifact: async () => {
			throw new Error("model_timeout");
		},
	});
	await runScheduledMaintenance({} as Env, deps);
	const serialized = JSON.stringify(logs);
	assert.doesNotMatch(serialized, /model_timeout/);
	assert.doesNotMatch(serialized, /tenant-private/);
	assert.match(serialized, /generation_failed/);
	assert.match(serialized, /[a-f0-9]{12}/);
});

test("legacy phase uses a three-tenant keyset page and global five/two caps", async () => {
	const calls: string[] = [];
	const memories = Array.from({ length: 20 }, (_, index) => ({
		id: `memory-${index}`,
		text: "bounded",
		category: "context",
		layer: "episodic",
		salience: 0.5,
		pinned: false,
		last_verified: null,
		created_at: "2026-01-01T00:00:00.000Z",
		confidence: 0.8,
	})) as never[];
	const { deps } = dependencies({
		readLegacyMaintenanceCursor: async () => "tenant-0",
		listActiveUserIds: async (_env, cursor, limit) => {
			calls.push(`page:${cursor}:${limit}`);
			return ["tenant-1", "tenant-2", "tenant-3"];
		},
		getUnembeddedMemories: async (_userId, _env, limit) => {
			calls.push(`embedding-query:${limit}`);
			return memories;
		},
		storeMemoryVector: async () => {
			calls.push("embedding-attempt");
		},
		queryMemories: async (_userId, _env, input) => {
			calls.push(`decay-query:${input?.limit}`);
			return memories;
		},
		updateMemory: async (_id, _userId, updates) => {
			calls.push(
				"embedding_status" in updates
					? "embedding-update"
					: "confidence-update",
			);
		},
		writeLegacyMaintenanceCursor: async (_env, cursor) => {
			calls.push(`cursor:${cursor}`);
		},
	});
	await runScheduledMaintenance({} as Env, deps);
	assert.equal(calls.filter((call) => call === "embedding-attempt").length, 5);
	assert.equal(calls.filter((call) => call === "confidence-update").length, 2);
	assert.ok(
		calls
			.filter((call) => call.includes("-query:"))
			.every((call) => call.endsWith(":20") || call.endsWith(":5")),
	);
	assert.ok(calls.includes("page:tenant-0:3"));
	assert.ok(calls.includes("cursor:tenant-1"));
});

test("wall-clock guard prevents starting another legacy unit", async () => {
	let tick = 0;
	const { deps } = dependencies({
		monotonicNowMs: () => (tick++ === 0 ? 0 : 20_001),
		listActiveUserIds: async () => ["tenant-private"],
		getUnembeddedMemories: async () => {
			throw new Error("deadline should stop before work");
		},
	});
	await runScheduledMaintenance({} as Env, deps);
});

test("legacy failures avoid raw tenant IDs and exception text", async () => {
	const { deps, logs } = dependencies({
		listActiveUserIds: async () => ["tenant-private"],
		getUnembeddedMemories: async () => {
			throw new Error("memory text must not reach logs");
		},
		listDueLivingSummaryTenants: async () => [],
	});
	await runScheduledMaintenance({} as Env, deps);
	const serialized = JSON.stringify(logs);
	assert.doesNotMatch(serialized, /tenant-private/);
	assert.doesNotMatch(serialized, /memory text must not reach logs/);
	assert.match(serialized, /maintenance_tenant_failed/);
	assert.match(serialized, /[a-f0-9]{12}/);
});

test("persisted backoff matches artifactRetryDelayMs at every boundary and the cap", async () => {
	const DB = createSqliteD1();
	const env = { DB } as Env;
	await initializeSqliteD1(env);
	for (let attempt = 1; attempt <= 8; attempt += 1) {
		await recordArtifactRebuildFailure(
			"tenant-boundary",
			"living_summary",
			"generation_failed",
			NOW,
			env,
		);
		const state = await DB.prepare(
			`SELECT retry_count,next_retry_at FROM derived_artifact_rebuild_state
			 WHERE userId=? AND kind='living_summary'`,
		)
			.bind("tenant-boundary")
			.first<{ retry_count: number; next_retry_at: string }>();
		assert.equal(state?.retry_count, attempt);
		assert.equal(
			state?.next_retry_at,
			new Date(NOW.getTime() + artifactRetryDelayMs(attempt)).toISOString(),
			`retry ${attempt} must follow the shared delay curve`,
		);
	}
	// The eighth failure is already past the 6-step ladder, so it must be capped.
	assert.equal(artifactRetryDelayMs(8), 24 * 60 * 60_000);
	DB.close();
});

test("overlapping failure callers increment once each without reading retry_count", async () => {
	const DB = createSqliteD1();
	await initializeSqliteD1({ DB } as Env);
	const calls: Array<{ sql: string; values: unknown[] }> = [];
	let arrived = 0;
	let release!: () => void;
	const opened = new Promise<void>((resolve) => {
		release = resolve;
	});
	let chain: Promise<unknown> = Promise.resolve();
	const wrap = (bound: D1PreparedStatement, sql: string): D1PreparedStatement =>
		({
			bind: (...values: unknown[]) => {
				calls.push({ sql, values });
				return wrap(bound.bind(...values), sql);
			},
			run: () => bound.run(),
			all: () => bound.all(),
			first: (column?: string) => bound.first(column),
		}) as unknown as D1PreparedStatement;
	const env = {
		DB: {
			prepare: (sql: string) => wrap(DB.prepare(sql), sql),
			async batch(statements: D1PreparedStatement[]) {
				arrived += 1;
				if (arrived >= 2) release();
				// Both callers reach their batch before either one commits.
				await opened;
				const run = chain.then(() => DB.batch(statements));
				chain = run.then(
					() => undefined,
					() => undefined,
				);
				return run;
			},
		},
	} as unknown as Env;

	await Promise.all([
		recordArtifactRebuildFailure(
			"tenant-race",
			"living_summary",
			"model_timeout",
			NOW,
			env,
		),
		recordArtifactRebuildFailure(
			"tenant-race",
			"living_summary",
			"model_timeout",
			NOW,
			env,
		),
	]);

	assert.equal(calls.length, 4, "each caller prepares exactly two statements");
	assert.ok(
		calls.every(({ sql }) => !/select\s+retry_count/i.test(sql)),
		"the UPSERT derives the new count without a pre-batch read",
	);
	const state = await DB.prepare(
		`SELECT retry_count,next_retry_at FROM derived_artifact_rebuild_state
		 WHERE userId=? AND kind='living_summary'`,
	)
		.bind("tenant-race")
		.first<{ retry_count: number; next_retry_at: string }>();
	assert.equal(state?.retry_count, 2);
	assert.equal(state?.next_retry_at, "2026-07-24T07:00:00.000Z");
	const events = await DB.prepare(
		`SELECT COUNT(*) AS count FROM derived_artifact_events
		 WHERE userId=? AND event_type='generation_failed'`,
	)
		.bind("tenant-race")
		.first<{ count: number }>();
	assert.equal(events?.count, 2);
	const eventOperationIds = new Set(
		calls
			.filter(({ sql }) => sql.includes("derived_artifact_events"))
			.map(({ values }) => values[4]),
	);
	assert.equal(eventOperationIds.size, 2);
	DB.close();
});

test("a published living summary makes both failure statements no-ops", async () => {
	const DB = createSqliteD1();
	const env = { DB } as Env;
	await initializeSqliteD1(env);
	insertRow(DB, "derived_artifacts", publishedLivingSummaryRow("tenant-pub", "a1"));

	await recordArtifactRebuildFailure(
		"tenant-pub",
		"living_summary",
		"generation_failed",
		NOW,
		env,
	);
	const state = await DB.prepare(
		`SELECT COUNT(*) AS count FROM derived_artifact_rebuild_state WHERE userId=?`,
	)
		.bind("tenant-pub")
		.first<{ count: number }>();
	assert.equal(state?.count, 0);
	const events = await DB.prepare(
		`SELECT COUNT(*) AS count FROM derived_artifact_events WHERE userId=?`,
	)
		.bind("tenant-pub")
		.first<{ count: number }>();
	assert.equal(events?.count, 0);
	DB.close();
});

test("a later publication clears a previously recorded failure state", async () => {
	const DB = createSqliteD1();
	const env = { DB, KV: undefined } as unknown as Env;
	await initializeSqliteD1(env);
	await recordArtifactRebuildFailure(
		"tenant-order",
		"living_summary",
		"generation_failed",
		NOW,
		env,
	);
	const before = await DB.prepare(
		`SELECT retry_count FROM derived_artifact_rebuild_state WHERE userId=?`,
	)
		.bind("tenant-order")
		.first<{ retry_count: number }>();
	assert.equal(before?.retry_count, 1);

	const candidate = publishedLivingSummaryRow("tenant-order", "candidate-1");
	candidate.status = "candidate";
	candidate.published_at = null;
	insertRow(DB, "derived_artifacts", candidate);
	await createD1ArtifactStore(env).publishArtifact(
		"tenant-order",
		"candidate-1",
		"system",
	);

	const after = await DB.prepare(
		`SELECT COUNT(*) AS count FROM derived_artifact_rebuild_state WHERE userId=?`,
	)
		.bind("tenant-order")
		.first<{ count: number }>();
	assert.equal(after?.count, 0);
	DB.close();
});

test("a stable schema costs exactly two D1 statements and the legacy worst case stays below 50", async () => {
	const DB = createSqliteD1();
	const kv = new Map<string, string>();
	const env = {
		DB,
		KV: {
			get: async (key: string) => kv.get(key) ?? null,
			put: async (key: string, value: string) => {
				kv.set(key, value);
			},
			delete: async (key: string) => {
				kv.delete(key);
			},
		},
	} as unknown as Env;
	await initializeSqliteD1(env);
	for (const [index, tenant] of ["tenant-a", "tenant-b", "tenant-c"].entries()) {
		insertRow(
			DB,
			"derived_artifacts",
			publishedLivingSummaryRow(tenant, `active-${index}`),
		);
		for (let n = 0; n < 20; n += 1) {
			insertRow(DB, "memories", memoryRow(tenant, `${tenant}-m${n}`));
		}
	}

	DB.resetQueryCount();
	const schema = await initializeDatabase(env);
	assert.deepEqual(
		{ ready: schema.ready, changed: schema.changed, queryCount: schema.queryCount },
		{ ready: true, changed: false, queryCount: 2 },
	);
	assert.equal(DB.queryCount(), 2, "a stable schema check executes two statements");

	DB.resetQueryCount();
	const logs: Array<Record<string, unknown>> = [];
	let embeddingCalls = 0;
	await runScheduledMaintenance(env, {
		now: () => NOW,
		storeMemoryVector: async () => {
			embeddingCalls += 1;
		},
		log: (entry) => logs.push(entry),
	});
	const observed = DB.queryCount();
	assert.equal(embeddingCalls, 5);
	assert.deepEqual(logs.at(-1), {
		event: "maintenance_completed",
		phase: "legacy",
		tenant_count: 1,
		embedding_attempt_count: 5,
		confidence_attempt_count: 2,
	});
	assert.ok(
		observed <= 46,
		`legacy worst case executed ${observed} D1 statements (plan ceiling 46)`,
	);
	assert.ok(observed < 50, `cron invocation must stay below 50, saw ${observed}`);
	const embedded = await DB.prepare(
		`SELECT COUNT(*) AS count FROM memories WHERE embedding_status='embedded'`,
	)
		.bind()
		.first<{ count: number }>();
	assert.equal(embedded?.count, 5);
	DB.close();
});

test("a schema-changing invocation runs no maintenance phase and stays below 50", async () => {
	const DB = createSqliteD1();
	const env = { DB } as Env;
	let observed: { ready: boolean; changed: boolean; queryCount: number } | null =
		null;
	const forbidden = () => {
		throw new Error("no maintenance phase may run while the schema advances");
	};
	await runScheduledMaintenance(env, {
		initializeDatabase: async (target) => {
			observed = await initializeDatabase(target);
			return observed;
		},
		purgeDueArtifactCaches: async () => forbidden(),
		listDueLivingSummaryTenants: async () => forbidden(),
		readLegacyMaintenanceCursor: async () => forbidden(),
		listActiveUserIds: async () => forbidden(),
		getUnembeddedMemories: async () => forbidden(),
		queryMemories: async () => forbidden(),
		log: () => {},
	});
	assert.ok(observed);
	assert.equal(observed!.changed, true);
	assert.equal(
		DB.queryCount(),
		observed!.queryCount,
		"the adapter counts every executed statement, including batch members",
	);
	assert.ok(
		observed!.queryCount <= 49,
		`schema advancement used ${observed!.queryCount} statements`,
	);
	DB.close();
});
