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
	COORDINATION_HANDOFF_STATES,
	COORDINATION_PROVENANCE,
	COUNCIL_ROLES,
	COUNCIL_VOTES,
	type DerivedArtifact,
} from "../src/types";
import { createSqliteD1 } from "./helpers/sqlite-d1";

const envFor = (DB: D1Database) => ({ DB }) as Env;

async function tableNames(DB: D1Database): Promise<string[]> {
	const rows = await DB.prepare(
		`SELECT name FROM sqlite_master
		 WHERE type='table' AND name NOT LIKE 'sqlite_%'
		 ORDER BY name`,
	).all<{ name: string }>();
	return rows.results.map(({ name }) => name);
}

async function columnNames(DB: D1Database, table: string): Promise<string[]> {
	const rows = await DB.prepare(`PRAGMA table_info(${table})`).all<{
		name: string;
	}>();
	return rows.results.map(({ name }) => name);
}

async function count(DB: D1Database, table: string): Promise<number> {
	const row = await DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{
		count: number;
	}>();
	return row?.count ?? 0;
}

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

test("coordination enums match the approved contract", () => {
	assert.deepEqual(COORDINATION_PROVENANCE, [
		"user",
		"document",
		"agent",
		"inference",
	]);
	assert.deepEqual(COORDINATION_HANDOFF_STATES, [
		"draft",
		"submitted",
		"verified",
		"rejected",
		"expired",
	]);
	assert.deepEqual(COUNCIL_ROLES, [
		"evidence",
		"user_intent",
		"safety",
		"privacy",
		"strategy",
		"operations",
		"adversarial_review",
	]);
	assert.deepEqual(COUNCIL_VOTES, ["approve", "reject", "escalate"]);
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

test("coordination migration is additive and preserves legacy rows", async (t) => {
	const DB = createSqliteD1();
	t.after(() => DB.close());
	const env = envFor(DB);
	await initializeDatabase(env);
	for (;;) {
		const status = await readDatabaseMigrationStatus(env);
		if (status.nextVersion === 5) {
			assert.deepEqual(status.appliedVersions, [1, 2, 3, 4]);
			break;
		}
		assert.equal(status.ready, false);
		await initializeDatabase(env);
	}
	await DB.prepare(
		`INSERT INTO ai_notes (id,userId,agent_id,key,content)
		 VALUES ('note-1','u1','agent-a','handoff','legacy note')`,
	).run();
	await DB.prepare(
		`INSERT INTO agent_tasks (id,userId,title)
		 VALUES ('task-1','u1','Legacy task')`,
	).run();
	const aiNoteColumns = await columnNames(DB, "ai_notes");
	const agentTaskColumns = await columnNames(DB, "agent_tasks");

	await initializeUntilReady(env);

	assert.deepEqual(await tableNames(DB), [
		"agent_presence",
		"agent_runs",
		"agent_tasks",
		"ai_notes",
		"artifact_cache_purge_queue",
		"behavioral_observations",
		"coordination_handoff_reviews",
		"coordination_handoffs",
		"coordination_task_events",
		"coordination_task_leases",
		"council_events",
		"council_proposals",
		"council_votes",
		"derived_artifact_events",
		"derived_artifact_evidence_state",
		"derived_artifact_legacy_state",
		"derived_artifact_rebuild_state",
		"derived_artifact_sources",
		"derived_artifacts",
		"memories",
		"pending_updates",
		"people",
		"person_profiles",
		"personality_feedback",
		"profile_facts",
		"schema_migrations",
		"session_logs",
		"transcripts",
		"uncertainties",
	]);
	assert.deepEqual(await columnNames(DB, "ai_notes"), aiNoteColumns);
	assert.deepEqual(await columnNames(DB, "agent_tasks"), agentTaskColumns);
	assert.equal(await count(DB, "ai_notes"), 1);
	assert.equal(await count(DB, "agent_tasks"), 1);
});

test("coordination foreign keys reject cross-tenant parent references", async (t) => {
	const DB = createSqliteD1();
	t.after(() => DB.close());
	await initializeUntilReady(envFor(DB));
	await DB.prepare(
		`INSERT INTO agent_tasks (id,userId,title)
		 VALUES ('task-b','tenant-b','Tenant B task')`,
	).run();
	await DB.prepare(
		`INSERT INTO coordination_handoffs
		 (id,userId,from_agent,to_agent,summary,next_steps,provenance,confidence,
		  content_sha256,actor_id)
		 VALUES ('handoff-b','tenant-b','author','recipient','summary','next',
		  'agent',0.8,'sha','author')`,
	).run();
	await DB.prepare(
		`INSERT INTO council_proposals
		 (id,userId,question,council_roles_json,actor_id)
		 VALUES ('proposal-b','tenant-b','Question?','[]','server')`,
	).run();

	await assert.rejects(
		DB.prepare(
			`INSERT INTO coordination_handoff_reviews
			 (id,userId,handoff_id,reviewer_id,decision,actor_id)
			 VALUES ('review-a','tenant-a','handoff-b','reviewer','verified','reviewer')`,
		).run(),
		/foreign key/i,
	);
	await assert.rejects(
		DB.prepare(
			`INSERT INTO coordination_task_leases
			 (id,userId,task_id,lease_id,holder_id,leased_at,heartbeat_at,
			  expires_at,actor_id)
			 VALUES ('lease-a','tenant-a','task-b','opaque-a','worker',
			  '2026-01-01','2026-01-01','2026-01-02','worker')`,
		).run(),
		/foreign key/i,
	);
	await assert.rejects(
		DB.prepare(
			`INSERT INTO coordination_task_events
			 (id,userId,task_id,lease_id,event_type,actor_id)
			 VALUES ('task-event-a','tenant-a','task-b','opaque-a','claimed','worker')`,
		).run(),
		/foreign key/i,
	);
	await assert.rejects(
		DB.prepare(
			`INSERT INTO council_votes
			 (id,userId,proposal_id,council_role,vote,reason,actor_id)
			 VALUES ('vote-a','tenant-a','proposal-b','evidence','approve',
			  'reason','server')`,
		).run(),
		/foreign key/i,
	);
	await assert.rejects(
		DB.prepare(
			`INSERT INTO council_events
			 (id,userId,proposal_id,event_type,actor_id)
			 VALUES ('council-event-a','tenant-a','proposal-b',
			  'proposal_created','server')`,
		).run(),
		/foreign key/i,
	);
});

test("coordination checks and unique audit constraints are enforced", async (t) => {
	const DB = createSqliteD1();
	t.after(() => DB.close());
	await initializeUntilReady(envFor(DB));
	const handoff = (id: string, provenance: string, confidence: number) =>
		DB.prepare(
			`INSERT INTO coordination_handoffs
			 (id,userId,from_agent,to_agent,summary,next_steps,provenance,confidence,
			  content_sha256,actor_id)
			 VALUES (?,'u1','author','recipient','summary','next',?,?,'sha','author')`,
		).bind(id, provenance, confidence);
	await assert.rejects(handoff("bad-provenance", "unknown", 0.5).run());
	await assert.rejects(handoff("bad-confidence", "agent", 1.1).run());
	await handoff("handoff-1", "agent", 0.8).run();
	await DB.prepare(
		`INSERT INTO coordination_handoff_reviews
		 (id,userId,handoff_id,reviewer_id,decision,actor_id)
		 VALUES ('review-1','u1','handoff-1','reviewer','verified','reviewer')`,
	).run();
	await assert.rejects(
		DB.prepare(
			`INSERT INTO coordination_handoff_reviews
			 (id,userId,handoff_id,reviewer_id,decision,actor_id)
			 VALUES ('review-2','u1','handoff-1','reviewer','rejected','reviewer')`,
		).run(),
	);

	await DB.prepare(
		`INSERT INTO council_proposals
		 (id,userId,question,council_roles_json,actor_id)
		 VALUES ('proposal-1','u1','Question?','[]','server')`,
	).run();
	await DB.prepare(
		`INSERT INTO council_votes
		 (id,userId,proposal_id,council_role,vote,reason,actor_id)
		 VALUES ('vote-1','u1','proposal-1','evidence','approve','reason','server')`,
	).run();
	await assert.rejects(
		DB.prepare(
			`INSERT INTO council_votes
			 (id,userId,proposal_id,council_role,vote,reason,actor_id)
			 VALUES ('vote-2','u1','proposal-1','evidence','reject','reason','server')`,
		).run(),
	);
	await assert.rejects(
		DB.prepare(
			`INSERT INTO council_votes
			 (id,userId,proposal_id,council_role,vote,reason,actor_id)
			 VALUES ('vote-3','u1','proposal-1','caller_role','approve','reason','server')`,
		).run(),
	);
	await assert.rejects(
		DB.prepare(
			`INSERT INTO council_votes
			 (id,userId,proposal_id,council_role,vote,reason,actor_id)
			 VALUES ('vote-4','u1','proposal-1','privacy','abstain','reason','server')`,
		).run(),
	);
	await DB.prepare(
		`INSERT INTO council_events
		 (id,userId,proposal_id,event_type,outcome,actor_id)
		 VALUES ('decision-1','u1','proposal-1','decision_finalized','approved','server')`,
	).run();
	await assert.rejects(
		DB.prepare(
			`INSERT INTO council_events
			 (id,userId,proposal_id,event_type,outcome,actor_id)
			 VALUES ('decision-2','u1','proposal-1','decision_finalized',
			  'rejected','server')`,
		).run(),
	);
});

test("every coordination secondary index begins with userId", async (t) => {
	const DB = createSqliteD1();
	t.after(() => DB.close());
	await initializeUntilReady(envFor(DB));
	for (const table of [
		"coordination_handoffs",
		"coordination_handoff_reviews",
		"coordination_task_leases",
		"coordination_task_events",
		"council_proposals",
		"council_votes",
		"council_events",
	]) {
		const indexes = await DB.prepare(`PRAGMA index_list(${table})`).all<{
			name: string;
			origin: string;
		}>();
		const secondary = indexes.results.filter(({ origin }) => origin === "c");
		assert.ok(secondary.length > 0, `${table} has a secondary index`);
		for (const { name } of secondary) {
			const columns = await DB.prepare(`PRAGMA index_info(${name})`).all<{
				seqno: number;
				name: string;
			}>();
			assert.equal(
				columns.results.sort((a, b) => a.seqno - b.seqno)[0]?.name,
				"userId",
				`${name} begins with userId`,
			);
		}
	}
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
