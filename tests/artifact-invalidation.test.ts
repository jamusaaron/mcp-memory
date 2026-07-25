import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { DATABASE_MIGRATIONS } from "../src/migrations";
import { updateMemory } from "../src/utils/db";
import type { ArtifactKind } from "../src/types";
import { createSqliteD1 } from "./helpers/sqlite-d1";

// ── Invalidation harness (built on the real SQLite D1 adapter) ──
//
// invalidationEnv() sets up a fully-migrated in-memory SQLite schema
// synchronously, seeds fixtures, and returns an Env whose DB.batch() genuinely
// runs BEGIN IMMEDIATE/COMMIT/ROLLBACK so rollback is exercised by SQLite. The
// KV double records every deleted key into `deletedCacheKeys`, and a
// `failStatement` substring can force a specific prepared statement to throw.

type ArtifactFixture = {
	id: string;
	userId?: string;
	kind?: ArtifactKind;
	status?: string;
	validation_state?: string;
	content_json?: string | null;
	rendered_text?: string | null;
	source_watermark?: string | null;
	created_at?: string;
};

type SourceLinkFixture = {
	artifact_id: string;
	source_id: string;
	userId?: string;
	claim_id?: string;
	source_kind?: string;
	source_updated_at?: string;
	source_sha256?: string;
	citation_role?: string;
};

type MemoryFixture = {
	id: string;
	userId?: string;
	category?: string;
	layer?: string;
	text?: string;
	created_at?: string;
	updated_at?: string;
};

type InvalidationConfig = {
	active?: ArtifactFixture[];
	sources?: SourceLinkFixture[];
	cache?: string[];
	memories?: MemoryFixture[];
	failStatement?: string;
};

type InvalidationEnv = Env & {
	deletedCacheKeys: Set<string>;
	__raw: DatabaseSync;
};

const BASELINE_DDL = [
	`CREATE TABLE IF NOT EXISTS memories (
		id TEXT PRIMARY KEY,
		userId TEXT NOT NULL,
		category TEXT NOT NULL DEFAULT 'knowledge',
		layer TEXT NOT NULL DEFAULT 'current',
		subject TEXT,
		text TEXT NOT NULL,
		tags TEXT DEFAULT '[]',
		triggers TEXT DEFAULT '[]',
		confidence REAL DEFAULT 0.8,
		salience REAL DEFAULT 0.5,
		emotion_weight REAL DEFAULT 0.0,
		source_type TEXT DEFAULT 'stated',
		linked_people TEXT DEFAULT '[]',
		embedding_status TEXT DEFAULT 'pending',
		suppressed INTEGER DEFAULT 0,
		suppression_reason TEXT,
		last_accessed TEXT,
		last_verified TEXT,
		pinned INTEGER DEFAULT 0,
		access_count INTEGER DEFAULT 0,
		created_at TEXT DEFAULT CURRENT_TIMESTAMP,
		updated_at TEXT DEFAULT CURRENT_TIMESTAMP
	)`,
	`CREATE TABLE IF NOT EXISTS behavioral_observations (
		id TEXT PRIMARY KEY,
		userId TEXT NOT NULL,
		observation_type TEXT NOT NULL,
		content TEXT NOT NULL,
		context TEXT,
		source_type TEXT NOT NULL DEFAULT 'observed',
		confidence REAL NOT NULL DEFAULT 0.5,
		status TEXT NOT NULL DEFAULT 'active',
		verified_at TEXT,
		created_at TEXT DEFAULT CURRENT_TIMESTAMP
	)`,
	`CREATE TABLE IF NOT EXISTS personality_feedback (
		id TEXT PRIMARY KEY,
		userId TEXT NOT NULL,
		persona TEXT DEFAULT 'default',
		tone TEXT,
		mode TEXT,
		situation TEXT,
		outcome TEXT,
		feedback_score REAL,
		created_at TEXT DEFAULT CURRENT_TIMESTAMP
	)`,
];

function buildSchema(raw: DatabaseSync): void {
	for (const sql of BASELINE_DDL) raw.exec(sql);
	for (const migration of DATABASE_MIGRATIONS) {
		for (const sql of migration.statements) raw.exec(sql);
	}
}

function insertMemoryRow(raw: DatabaseSync, m: MemoryFixture): void {
	raw
		.prepare(
			`INSERT INTO memories (id,userId,category,layer,text,created_at,updated_at)
			 VALUES (?,?,?,?,?,?,?)`,
		)
		.run(
			m.id,
			m.userId ?? "u1",
			m.category ?? "identity",
			m.layer ?? "current",
			m.text ?? "Original",
			m.created_at ?? "2026-07-20T00:00:00.000Z",
			m.updated_at ?? "2026-07-20T00:00:00.000Z",
		);
}

function insertArtifactRow(
	raw: DatabaseSync,
	a: ArtifactFixture,
	versions: Map<string, number>,
): void {
	const userId = a.userId ?? "u1";
	const kind = a.kind ?? "living_summary";
	const key = `${userId}:${kind}`;
	const version = (versions.get(key) ?? 0) + 1;
	versions.set(key, version);
	raw
		.prepare(
			`INSERT INTO derived_artifacts
			 (id,userId,kind,version,status,validation_state,content_json,rendered_text,
			  source_watermark,evidence_generation,prompt_version,validation_json,created_at)
			 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		)
		.run(
			a.id,
			userId,
			kind,
			version,
			a.status ?? "published",
			a.validation_state ?? "validated",
			a.content_json === undefined ? '{"claims":[]}' : a.content_json,
			a.rendered_text === undefined ? "rendered text" : a.rendered_text,
			a.source_watermark ?? "watermark",
			0,
			"test-v1",
			"{}",
			a.created_at ?? "2026-07-20T00:00:00.000Z",
		);
}

function insertSourceLinkRow(raw: DatabaseSync, s: SourceLinkFixture): void {
	raw
		.prepare(
			`INSERT INTO derived_artifact_sources
			 (artifact_id,userId,claim_id,source_kind,source_id,source_updated_at,source_sha256,citation_role)
			 VALUES (?,?,?,?,?,?,?,?)`,
		)
		.run(
			s.artifact_id,
			s.userId ?? "u1",
			s.claim_id ?? "claim-1",
			s.source_kind ?? "memory",
			s.source_id,
			s.source_updated_at ?? "2026-07-20T00:00:00.000Z",
			s.source_sha256 ?? "0".repeat(64),
			s.citation_role ?? "supporting",
		);
}

function makeFailingStatement(): D1PreparedStatement {
	const stmt = {
		bind: () => stmt,
		run: async () => {
			throw new Error("forced D1 failure");
		},
		all: async () => {
			throw new Error("forced D1 failure");
		},
		first: async () => {
			throw new Error("forced D1 failure");
		},
	};
	return stmt as unknown as D1PreparedStatement;
}

export function invalidationEnv(config: InvalidationConfig = {}): InvalidationEnv {
	const base = createSqliteD1();
	const raw = base.raw;
	buildSchema(raw);

	const memories = config.memories ?? [{ id: "memory-1", userId: "u1" }];
	for (const m of memories) insertMemoryRow(raw, m);

	const versions = new Map<string, number>();
	for (const a of config.active ?? []) insertArtifactRow(raw, a, versions);
	for (const s of config.sources ?? []) insertSourceLinkRow(raw, s);

	const kv = new Map<string, string>();
	for (const key of config.cache ?? []) kv.set(key, "cached-bytes");
	const deletedCacheKeys = new Set<string>();
	const KV = {
		get: async (key: string) => kv.get(key) ?? null,
		put: async (key: string, value: string) => {
			kv.set(key, value);
		},
		delete: async (key: string) => {
			deletedCacheKeys.add(key);
			kv.delete(key);
		},
	} as unknown as KVNamespace;

	const failStatement = config.failStatement;
	const DB = {
		prepare(sql: string) {
			if (failStatement && sql.includes(failStatement)) {
				return makeFailingStatement();
			}
			return base.prepare(sql);
		},
		batch<T>(statements: D1PreparedStatement[]) {
			return base.batch<T>(statements);
		},
		exec(sql: string) {
			return base.exec(sql);
		},
	} as unknown as D1Database;

	return {
		DB,
		KV,
		deletedCacheKeys,
		__raw: raw,
	} as unknown as InvalidationEnv;
}

export function artifactById(
	env: InvalidationEnv,
	id: string,
): Record<string, unknown> | null {
	const row = env.__raw
		.prepare("SELECT * FROM derived_artifacts WHERE id=?")
		.get(id) as Record<string, unknown> | undefined;
	return row ? { ...row } : null;
}

export function activeStatuses(
	env: InvalidationEnv,
	userId: string,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const kind of ["living_summary", "self_profile", "behavioral_profile"]) {
		const row = env.__raw
			.prepare(
				`SELECT status FROM derived_artifacts
				 WHERE userId=? AND kind=? AND status IN ('published','stale')
				 ORDER BY version DESC LIMIT 1`,
			)
			.get(userId, kind) as { status: string } | undefined;
		if (row) out[kind] = row.status;
	}
	return out;
}

export function evidenceGeneration(
	env: InvalidationEnv,
	userId: string,
	kind: string,
): number {
	const row = env.__raw
		.prepare(
			"SELECT generation FROM derived_artifact_evidence_state WHERE userId=? AND kind=?",
		)
		.get(userId, kind) as { generation: number } | undefined;
	return row ? Number(row.generation) : 0;
}

export function memoryUpdatedAt(env: InvalidationEnv, id: string): string | null {
	const row = env.__raw
		.prepare("SELECT updated_at FROM memories WHERE id=?")
		.get(id) as { updated_at: string } | undefined;
	return row ? row.updated_at : null;
}

export function memoryText(env: InvalidationEnv, id: string): string | null {
	const row = env.__raw
		.prepare("SELECT text FROM memories WHERE id=?")
		.get(id) as { text: string } | undefined;
	return row ? row.text : null;
}

test("memory mutations stale only affected active artifact kinds", async () => {
	const env = invalidationEnv({
		active: [
			artifact({ id: "living", kind: "living_summary", status: "published" }),
			artifact({ id: "self", kind: "self_profile", status: "published" }),
			artifact({
				id: "behavior",
				kind: "behavioral_profile",
				status: "published",
			}),
			artifact({
				id: "living-candidate",
				kind: "living_summary",
				status: "candidate",
			}),
			artifact({
				id: "self-candidate",
				kind: "self_profile",
				status: "candidate",
			}),
		],
	});

	await updateMemory(
		"memory-1",
		"u1",
		{ category: "preferences", text: "Prefers concise answers" },
		env,
	);

	assert.deepEqual(activeStatuses(env, "u1"), {
		living_summary: "stale",
		self_profile: "stale",
		behavioral_profile: "published",
	});
	assert.equal(artifactById(env, "living-candidate")!.status, "rejected");
	assert.equal(artifactById(env, "self-candidate")!.status, "rejected");
	assert.equal(evidenceGeneration(env, "u1", "living_summary"), 1);
	assert.equal(evidenceGeneration(env, "u1", "self_profile"), 1);
});

test("access and embedding updates do not stale artifacts", async () => {
	const env = invalidationEnv({
		active: [
			artifact({ id: "living", kind: "living_summary", status: "published" }),
		],
	});
	const before = memoryUpdatedAt(env, "memory-1");

	await updateMemory(
		"memory-1",
		"u1",
		{
			access_count: 4,
			last_accessed: "2026-07-24T00:00:00.000Z",
			embedding_status: "embedded",
		},
		env,
	);

	assert.equal(activeStatuses(env, "u1").living_summary, "published");
	assert.equal(memoryUpdatedAt(env, "memory-1"), before);
});

test("failed evidence update rolls back artifact invalidation", async () => {
	const env = invalidationEnv({
		failStatement: "UPDATE memories",
		active: [
			artifact({ id: "living", kind: "living_summary", status: "published" }),
		],
	});

	await assert.rejects(
		updateMemory("memory-1", "u1", { text: "Changed" }, env),
		/forced D1 failure/,
	);
	assert.equal(memoryText(env, "memory-1"), "Original");
	assert.equal(activeStatuses(env, "u1").living_summary, "published");
});

export function artifact(overrides: ArtifactFixture): ArtifactFixture {
	return overrides;
}
