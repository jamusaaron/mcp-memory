import assert from "node:assert/strict";
import test from "node:test";

import {
	DATABASE_MIGRATIONS,
	readDatabaseMigrationStatus,
} from "../src/migrations";
import { initializeDatabase } from "../src/schema";
import {
	ARTIFACT_KINDS,
	ARTIFACT_STATUSES,
	type DerivedArtifact,
} from "../src/types";
import { createSqliteD1 } from "./helpers/sqlite-d1";

const envFor = (DB: D1Database) => ({ DB }) as Env;

async function initializeUntilReady(env: Env): Promise<void> {
	for (let attempt = 0; attempt < DATABASE_MIGRATIONS.length + 3; attempt += 1) {
		const result = await initializeDatabase(env);
		if (result.ready && !result.changed) return;
	}
	throw new Error("Database did not reach a stable current schema");
}

test("artifact enums match the approved contract", () => {
	assert.deepEqual(ARTIFACT_KINDS, [
		"living_summary",
		"self_profile",
		"behavioral_profile",
	]);
	assert.deepEqual(ARTIFACT_STATUSES, [
		"candidate",
		"published",
		"stale",
		"superseded",
		"rejected",
		"tombstoned",
	]);
	const compileShape: Pick<DerivedArtifact, "kind" | "status"> = {
		kind: "living_summary",
		status: "stale",
	};
	assert.equal(compileShape.kind, "living_summary");
});

test("artifact migration defines all approved tables and active uniqueness", () => {
	const sql = DATABASE_MIGRATIONS
		.flatMap((migration) => migration.statements)
		.join("\n");
	for (const table of [
		"derived_artifacts",
			"derived_artifact_sources",
			"derived_artifact_events",
			"derived_artifact_rebuild_state",
			"derived_artifact_evidence_state",
			"derived_artifact_legacy_state",
			"artifact_cache_purge_queue",
			"profile_facts",
	]) {
		assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
	}
	assert.match(sql, /WHERE status IN \('published','stale'\)/);
	assert.match(sql, /WHERE status='candidate'/);
	assert.match(sql, /state IN \('imported','retired'\)/);
	assert.match(
		sql,
		/ON derived_artifacts\(userId,kind,created_at DESC\)/,
	);
});

test("fresh initialization advances in bounded steps and becomes idempotent", async (t) => {
	const DB = createSqliteD1();
	t.after(() => DB.close());
	const env = envFor(DB);
	const steps = [];
	for (let attempt = 0; attempt < DATABASE_MIGRATIONS.length + 3; attempt += 1) {
		DB.resetQueryCount();
		const result = await initializeDatabase(env);
		assert.equal(result.queryCount, DB.queryCount());
		assert.ok(result.queryCount < 50);
		steps.push(result);
		if (result.ready && !result.changed) break;
	}
	assert.equal(steps.at(-1)?.ready, true);
	assert.equal(steps.at(-1)?.changed, false);
	assert.ok(steps.slice(0, -1).every((step) => step.changed));
	const rows = await DB.prepare(
		"SELECT version,name FROM schema_migrations ORDER BY version",
	).all<{ version: number; name: string }>();
	assert.deepEqual(
		rows.results,
		DATABASE_MIGRATIONS.map(({ version, name }) => ({ version, name })),
	);
	DB.resetQueryCount();
	const current = await initializeDatabase(env);
	assert.deepEqual(current, { ready: true, changed: false, queryCount: 2 });
	assert.equal(DB.queryCount(), 2);
});

test("real SQLite enforces one active and one same-watermark candidate", async (t) => {
	const DB = createSqliteD1();
	t.after(() => DB.close());
	await initializeUntilReady(envFor(DB));
	const insert = (id: string, status: string, watermark: string, version: number) =>
		DB.prepare(
			`INSERT INTO derived_artifacts
			 (id,userId,kind,version,status,validation_state,source_watermark,prompt_version)
			 VALUES(?,?,?,?,?,'validated',?,'test')`,
		).bind(id, "u1", "living_summary", version, status, watermark);
	await insert("a1", "published", "w1", 1).run();
	await assert.rejects(insert("a2", "stale", "w2", 2).run());
	await insert("c1", "candidate", "w3", 3).run();
	await assert.rejects(insert("c2", "candidate", "w3", 4).run());
});

test("migration runner rejects changed name or checksum", async (t) => {
	const DB = createSqliteD1();
	t.after(() => DB.close());
	const env = envFor(DB);
	await initializeUntilReady(env);
	await DB.prepare(
		"UPDATE schema_migrations SET checksum='wrong' WHERE version=2",
	).run();
	await assert.rejects(
		readDatabaseMigrationStatus(env),
		/checksum mismatch/i,
	);
});

test("unexpected DDL errors propagate and batch changes roll back", async (t) => {
	const DB = createSqliteD1();
	t.after(() => DB.close());
	await assert.rejects(
		DB.batch([
			DB.prepare("CREATE TABLE rollback_probe(id TEXT PRIMARY KEY)"),
			DB.prepare("THIS IS NOT SQL"),
		]),
	);
	const row = await DB.prepare(
		"SELECT name FROM sqlite_master WHERE name='rollback_probe'",
	).first();
	assert.equal(row, null);
});
