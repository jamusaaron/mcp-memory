import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { DATABASE_MIGRATIONS } from "../src/migrations";
import { deleteMemory } from "../src/utils/db";
import type { ArtifactKind } from "../src/types";
import { createSqliteD1 } from "./helpers/sqlite-d1";

// ── Deletion harness (built on the real SQLite D1 adapter) ──
//
// Mirrors the invalidation harness: a fully-migrated in-memory schema seeded
// synchronously, a KV double that records deleted keys, and query helpers that
// read committed state directly from the underlying DatabaseSync.

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

	const DB = {
		prepare(sql: string) {
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

export function artifact(overrides: ArtifactFixture): ArtifactFixture {
	return overrides;
}

export function sourceLink(overrides: SourceLinkFixture): SourceLinkFixture {
	return overrides;
}

export function memory(overrides: MemoryFixture): MemoryFixture {
	return overrides;
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

export function rebuildState(
	env: InvalidationEnv,
	userId: string,
	kind: string,
): Record<string, unknown> | null {
	const row = env.__raw
		.prepare(
			"SELECT * FROM derived_artifact_rebuild_state WHERE userId=? AND kind=?",
		)
		.get(userId, kind) as Record<string, unknown> | undefined;
	return row ? { ...row } : null;
}

// Deletion audit events carry hashed source ids; return the tombstone events so
// the privacy assertion checks the deletion trail (invalidation events legitimately
// carry only mutation_reason/source_kind, never a raw or hashed source id).
export function events(env: InvalidationEnv): Array<{ metadata_json: string }> {
	const rows = env.__raw
		.prepare(
			"SELECT * FROM derived_artifact_events WHERE event_type='tombstoned' ORDER BY id",
		)
		.all() as Array<Record<string, unknown>>;
	return rows.map((row) => ({ ...row })) as Array<{ metadata_json: string }>;
}

export function sourceLinks(
	env: InvalidationEnv,
	sourceId: string,
): Array<Record<string, unknown>> {
	const rows = env.__raw
		.prepare("SELECT * FROM derived_artifact_sources WHERE source_id=?")
		.all(sourceId) as Array<Record<string, unknown>>;
	return rows.map((row) => ({ ...row }));
}

test("hard forget tombstones every cited artifact and removes cache content", async () => {
	const env = invalidationEnv({
		active: [
			artifact({
				id: "living",
				kind: "living_summary",
				status: "published",
				rendered_text: "Contains forgotten fact",
			}),
			artifact({
				id: "self-history",
				kind: "self_profile",
				status: "superseded",
				rendered_text: "Also contains forgotten fact",
			}),
			artifact({
				id: "legacy-self",
				kind: "self_profile",
				status: "stale",
				validation_state: "legacy_unverified",
				rendered_text: "Legacy content without source links",
			}),
			artifact({
				id: "legacy-self-history",
				kind: "self_profile",
				status: "superseded",
				validation_state: "legacy_unverified",
				rendered_text: "Superseded legacy content without source links",
			}),
		],
		sources: [
			sourceLink({ artifact_id: "living", source_id: "memory-1" }),
			sourceLink({ artifact_id: "self-history", source_id: "memory-1" }),
		],
		cache: [
			"artifact:u1:living_summary:living",
			"artifact:u1:self_profile:self-history",
			"artifact:u1:self_profile:legacy-self",
			"artifact:u1:self_profile:legacy-self-history",
		],
	});

	await deleteMemory("memory-1", "u1", env);

	for (const id of [
		"living",
		"self-history",
		"legacy-self",
		"legacy-self-history",
	]) {
		const item = artifactById(env, id)!;
		assert.equal(item.status, "tombstoned");
		assert.equal(item.content_json, null);
		assert.equal(item.rendered_text, null);
	}
	assert.equal(sourceLinks(env, "memory-1").length, 0);
	assert.deepEqual([...env.deletedCacheKeys].sort(), [
		"artifact:u1:living_summary:living",
		"artifact:u1:self_profile:legacy-self",
		"artifact:u1:self_profile:legacy-self-history",
		"artifact:u1:self_profile:self-history",
	]);
	assert.equal(
		rebuildState(env, "u1", "living_summary")!.next_retry_at !== null,
		true,
	);
	assert.ok(
		events(env).every(
			(event) =>
				!event.metadata_json.includes("memory-1") &&
				event.metadata_json.includes("source_id_sha256"),
		),
	);
});

test("hard deletion never touches another tenant", async () => {
	const env = invalidationEnv({
		memories: [memory({ id: "shared-id", userId: "u1" })],
		active: [
			artifact({ id: "u1-artifact", userId: "u1" }),
			artifact({ id: "u2-artifact", userId: "u2" }),
		],
		sources: [
			sourceLink({
				artifact_id: "u1-artifact",
				userId: "u1",
				source_id: "shared-id",
			}),
			sourceLink({
				artifact_id: "u2-artifact",
				userId: "u2",
				source_id: "shared-id",
			}),
		],
	});

	await deleteMemory("shared-id", "u1", env);

	assert.equal(artifactById(env, "u1-artifact")!.status, "tombstoned");
	assert.equal(artifactById(env, "u2-artifact")!.status, "published");
});

test("an unknown source cannot tombstone conservative legacy history", async () => {
	const env = invalidationEnv({
		active: [
			artifact({
				id: "legacy-self",
				kind: "self_profile",
				status: "superseded",
				validation_state: "legacy_unverified",
			}),
		],
	});
	await assert.rejects(deleteMemory("missing", "u1", env), /not found/i);
	assert.equal(artifactById(env, "legacy-self")!.status, "superseded");
});
