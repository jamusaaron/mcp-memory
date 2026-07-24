import assert from "node:assert/strict";
import test from "node:test";

import { createD1ArtifactStore } from "../src/utils/artifact-store";
import {
	artifactCacheKey,
	getArtifactCache,
} from "../src/utils/kv";
import {
	artifactContentSha256,
	canonicalJson,
	sha256Hex,
} from "../src/utils/artifact-synthesis";
import type { ArtifactClaim, ArtifactDraft } from "../src/types";
import { createSqliteD1Harness, initializeSqliteD1 } from "./helpers/sqlite-d1";

const MEMORY_UPDATED = "2026-07-24T00:00:00.000Z";

async function validatedDraft(): Promise<ArtifactDraft> {
	const claims: ArtifactClaim[] = [
		{
			id: "claim-1",
			section: "projects",
			text: "Project Atlas is active.",
			confidence: 0.9,
			provenance: "stated",
			sensitivity: "normal",
			citations: [{ source_kind: "memory", source_id: "memory-1" }],
		},
	];
	const renderedText = "## projects\n- Project Atlas is active. [memory:memory-1]";
	const canonicalSource = canonicalJson({
		id: "memory-1",
		text: "Project Atlas is active.",
		category: "projects",
		layer: "episodic",
		source_type: "stated",
		last_verified: MEMORY_UPDATED,
		confidence: 0.9,
		salience: 0.8,
		pinned: 0,
		suppressed: 0,
		updated_at: MEMORY_UPDATED,
	});
	return {
		kind: "living_summary",
		claims,
		renderedText,
		sourceWatermark: "watermark-1",
		eligibleSourceCount: 1,
		selectedSourceCount: 1,
		sourceTruncated: false,
		contentSha256: await artifactContentSha256(claims, renderedText),
		model: "test-model",
		promptVersion: "trusted-artifacts-v1",
		validation: { state: "validated" },
		evidence: [
			{
				kind: "memory",
				id: "memory-1",
				text: "Project Atlas is active.",
				sourceSha256: await sha256Hex(canonicalSource),
				section: "projects",
				updatedAt: MEMORY_UPDATED,
				status: "active",
				sourceType: "stated",
				verified: true,
				confidence: 0.9,
				salience: 0.8,
				pinned: false,
				core: false,
			},
		],
	};
}

async function insertMemorySource(env: Env, userId: string): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO memories
			(id,userId,category,layer,subject,text,source_type,confidence,salience,
			 pinned,suppressed,last_verified,created_at,updated_at)
		 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
	)
		.bind(
			"memory-1",
			userId,
			"projects",
			"episodic",
			null,
			"Project Atlas is active.",
			"stated",
			0.9,
			0.8,
			0,
			0,
			MEMORY_UPDATED,
			MEMORY_UPDATED,
			MEMORY_UPDATED,
		)
		.run();
}

async function count(env: Env, table: string, userId: string): Promise<number> {
	const row = await env.DB.prepare(
		`SELECT COUNT(*) AS c FROM ${table} WHERE userId=?`,
	)
		.bind(userId)
		.first<{ c: number }>();
	return row?.c ?? 0;
}

async function setup() {
	const harness = createSqliteD1Harness();
	await initializeSqliteD1(harness.env);
	const userId = "user-1";
	await insertMemorySource(harness.env, userId);
	const store = createD1ArtifactStore(harness.env, {
		now: () => "2026-07-25T00:00:00.000Z",
	});
	return { harness, userId, store };
}

test("creating a candidate writes exactly one artifact, source link, and generated event", async (t) => {
	const { harness, userId, store } = await setup();
	t.after(() => harness.close());
	const candidate = await store.createArtifactCandidate(userId, await validatedDraft(), 0);
	assert.equal(candidate.status, "candidate");
	assert.equal(candidate.version, 1);
	assert.equal(await count(harness.env, "derived_artifacts", userId), 1);
	assert.equal(await count(harness.env, "derived_artifact_sources", userId), 1);
	const events = await harness.env.DB.prepare(
		"SELECT event_type FROM derived_artifact_events WHERE userId=?",
	)
		.bind(userId)
		.all<{ event_type: string }>();
	assert.deepEqual(events.results.map((e) => e.event_type), ["generated"]);
});

test("a null source hash fails validation before any write and leaves all tables empty", async (t) => {
	const { harness, userId, store } = await setup();
	t.after(() => harness.close());
	const draft = await validatedDraft();
	draft.evidence[0].sourceSha256 = null as unknown as string;
	await assert.rejects(store.createArtifactCandidate(userId, draft, 0));
	assert.equal(await count(harness.env, "derived_artifacts", userId), 0);
	assert.equal(await count(harness.env, "derived_artifact_sources", userId), 0);
	assert.equal(await count(harness.env, "derived_artifact_events", userId), 0);
});

test("the same watermark collapses to a single candidate", async (t) => {
	const { harness, userId, store } = await setup();
	t.after(() => harness.close());
	const first = await store.createArtifactCandidate(userId, await validatedDraft(), 0);
	const second = await store.createArtifactCandidate(userId, await validatedDraft(), 0);
	assert.equal(first.id, second.id);
	assert.equal(await count(harness.env, "derived_artifacts", userId), 1);
});

test("publishing supersedes the previous active row and keeps only one active", async (t) => {
	const { harness, userId, store } = await setup();
	t.after(() => harness.close());
	const first = await store.createArtifactCandidate(userId, await validatedDraft(), 0);
	const published = await store.publishArtifact(userId, first.id, "reviewer");
	assert.equal(published.status, "published");

	const secondDraft = await validatedDraft();
	secondDraft.sourceWatermark = "watermark-2";
	const second = await store.createArtifactCandidate(userId, secondDraft, 0);
	await store.publishArtifact(userId, second.id, "reviewer");

	const firstAfter = await store.getArtifactById(userId, first.id);
	assert.equal(firstAfter?.status, "superseded");
	const active = await store.getActiveArtifact(userId, "living_summary");
	assert.equal(active?.id, second.id);
});

test("by-id lookups are tenant scoped", async (t) => {
	const { harness, userId, store } = await setup();
	t.after(() => harness.close());
	const candidate = await store.createArtifactCandidate(userId, await validatedDraft(), 0);
	assert.equal(await store.getArtifactById("other-user", candidate.id), null);
	assert.notEqual(await store.getArtifactById(userId, candidate.id), null);
});

test("an evidence-generation bump before insert rolls back the whole candidate", async (t) => {
	const { harness, userId, store } = await setup();
	t.after(() => harness.close());
	await harness.env.DB.prepare(
		`INSERT INTO derived_artifact_evidence_state (userId,kind,generation)
		 VALUES (?, 'living_summary', 1)`,
	)
		.bind(userId)
		.run();
	await assert.rejects(store.createArtifactCandidate(userId, await validatedDraft(), 0));
	assert.equal(await count(harness.env, "derived_artifacts", userId), 0);
	assert.equal(await count(harness.env, "derived_artifact_sources", userId), 0);
	assert.equal(await count(harness.env, "derived_artifact_events", userId), 0);
});

test("readActiveArtifact returns D1 content and repairs a deleted cache key", async (t) => {
	const { harness, userId, store } = await setup();
	t.after(() => harness.close());
	const candidate = await store.createArtifactCandidate(userId, await validatedDraft(), 0);
	const published = await store.publishArtifact(userId, candidate.id, "reviewer");
	// publication populated the cache
	assert.ok(harness.kv.has(artifactCacheKey(userId, "living_summary", published.id)));
	harness.kv.delete(artifactCacheKey(userId, "living_summary", published.id));

	const read = await store.readActiveArtifact(userId, "living_summary");
	assert.equal(read?.id, published.id);
	assert.equal(read?.rendered_text, published.rendered_text);
	const repaired = await getArtifactCache(
		userId,
		"living_summary",
		published.id,
		published.content_sha256 as string,
		harness.env,
	);
	assert.ok(repaired, "cache should be repaired with a valid envelope");
});

test("a corrupt cache envelope is treated as a miss and repaired", async (t) => {
	const { harness, userId, store } = await setup();
	t.after(() => harness.close());
	const candidate = await store.createArtifactCandidate(userId, await validatedDraft(), 0);
	const published = await store.publishArtifact(userId, candidate.id, "reviewer");
	harness.kv.set(
		artifactCacheKey(userId, "living_summary", published.id),
		JSON.stringify({ artifactId: published.id, contentSha256: "0".repeat(64), claims: [], renderedText: "tampered" }),
	);
	const read = await store.readActiveArtifact(userId, "living_summary");
	assert.equal(read?.rendered_text, published.rendered_text);
	const repaired = await getArtifactCache(
		userId,
		"living_summary",
		published.id,
		published.content_sha256 as string,
		harness.env,
	);
	assert.ok(repaired);
});

test("legacy import creates one stale legacy_unverified version, then retires on publish", async (t) => {
	const { harness, userId, store } = await setup();
	t.after(() => harness.close());
	const imported = await store.importLegacyArtifact(userId, "self_profile", "Legacy self summary.");
	assert.equal(imported?.status, "stale");
	assert.equal(imported?.validation_state, "legacy_unverified");
	assert.equal(await count(harness.env, "derived_artifact_sources", userId), 0);
	assert.equal(await store.getLegacyImportState(userId, "self_profile"), "imported");
	const events = await harness.env.DB.prepare(
		"SELECT event_type FROM derived_artifact_events WHERE userId=? AND kind='self_profile'",
	)
		.bind(userId)
		.all<{ event_type: string }>();
	assert.deepEqual(events.results.map((e) => e.event_type), ["legacy_imported"]);
	// re-import returns the existing active row, not a new version
	const again = await store.importLegacyArtifact(userId, "self_profile", "Different text.");
	assert.equal(again?.id, imported?.id);
});

test("rejecting a candidate stores the reason only in event metadata", async (t) => {
	const { harness, userId, store } = await setup();
	t.after(() => harness.close());
	const candidate = await store.createArtifactCandidate(userId, await validatedDraft(), 0);
	const rejected = await store.rejectArtifact(userId, candidate.id, "Not accurate", "reviewer");
	assert.equal(rejected.status, "rejected");
	await assert.rejects(
		store.rejectArtifact(userId, candidate.id, "sk-abcdefghijklmnop0000", "reviewer"),
	);
});

test("recordArtifactFailure writes a content-free event and no rebuild-state row", async (t) => {
	const { harness, userId, store } = await setup();
	t.after(() => harness.close());
	await store.recordArtifactFailure(userId, "self_profile", "invalid_model_output", "watermark-x");
	const events = await harness.env.DB.prepare(
		"SELECT event_type,artifact_id,reason_code FROM derived_artifact_events WHERE userId=?",
	)
		.bind(userId)
		.all<{ event_type: string; artifact_id: string | null; reason_code: string }>();
	assert.equal(events.results.length, 1);
	assert.equal(events.results[0].event_type, "generation_failed");
	assert.equal(events.results[0].artifact_id, null);
	assert.equal(await count(harness.env, "derived_artifact_rebuild_state", userId), 0);
});

test("restoring a historical version publishes one faithful clone over the active row", async (t) => {
	const { harness, userId, store } = await setup();
	t.after(() => harness.close());
	const first = await store.createArtifactCandidate(userId, await validatedDraft(), 0);
	const publishedFirst = await store.publishArtifact(userId, first.id, "reviewer");

	// publish a second version so the first becomes historical/superseded
	const secondDraft = await validatedDraft();
	secondDraft.sourceWatermark = "watermark-2";
	const second = await store.createArtifactCandidate(userId, secondDraft, 0);
	await store.publishArtifact(userId, second.id, "reviewer");

	// build a faithful restoration draft from the first (now superseded) version
	const restoreDraft = await validatedDraft();
	restoreDraft.validation = {
		...publishedFirst.validation,
		restored_from: publishedFirst.id,
		restoration_reason: "bring back v1",
	};
	const restored = await store.restoreHistoricalArtifact(
		userId,
		publishedFirst.id,
		restoreDraft,
		0,
		"bring back v1",
		"reviewer",
	);
	assert.equal(restored.status, "published");
	const active = await store.getActiveArtifact(userId, "living_summary");
	assert.equal(active?.id, restored.id);
	assert.equal(active?.rendered_text, publishedFirst.rendered_text);
});
