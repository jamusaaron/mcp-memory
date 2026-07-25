import assert from "node:assert/strict";
import test from "node:test";

import { createArtifactService } from "../src/utils/artifact-service";
import { artifactContentSha256, selectArtifactEvidence } from "../src/utils/artifact-synthesis";
import type { ArtifactClaim, ArtifactEvidence, ArtifactKind, DerivedArtifact } from "../src/types";

function evidence(overrides: Partial<ArtifactEvidence> = {}): ArtifactEvidence {
	return {
		kind: "memory",
		id: "m1",
		text: "Project Atlas is active.",
		sourceSha256: "sha-m1",
		section: "projects",
		updatedAt: "2026-07-24T00:00:00.000Z",
		status: "active",
		sourceType: "stated",
		verified: true,
		confidence: 0.9,
		salience: 0.8,
		pinned: false,
		core: false,
		...overrides,
	};
}

function artifact(overrides: Partial<DerivedArtifact> = {}): DerivedArtifact {
	return {
		id: "artifact-1",
		userId: "u1",
		kind: "living_summary",
		version: 1,
		status: "candidate",
		validation_state: "validated",
		claims: [],
		rendered_text: "## projects\n- Project Atlas is active. [memory:m1]",
		source_watermark: "watermark-1",
		evidence_generation: 0,
		eligible_source_count: 1,
		selected_source_count: 1,
		source_truncated: false,
		content_sha256: "hash",
		model: "test-model",
		prompt_version: "trusted-artifacts-v1",
		validation: {},
		supersedes_id: null,
		created_at: "2026-07-24T00:00:00.000Z",
		published_at: null,
		reviewed_at: null,
		reviewed_by: null,
		...overrides,
	};
}

const CLAIM: ArtifactClaim = {
	id: "c1",
	section: "projects",
	text: "Project Atlas is active.",
	confidence: 0.9,
	provenance: "stated",
	sensitivity: "normal",
	citations: [{ source_kind: "memory", source_id: "m1" }],
};

const FIXED_NOW = "2026-07-25T00:00:00.000Z";

type HarnessConfig = {
	memory?: { evidence: ArtifactEvidence[]; eligibleCount: number };
	kind?: ArtifactKind;
	active?: DerivedArtifact | null;
	candidate?: DerivedArtifact | null;
	artifactById?: DerivedArtifact | null;
	nextCandidate?: DerivedArtifact;
	currentEvidenceGeneration?: number;
	legacyImportState?: "imported" | "retired" | null;
	activeReads?: (DerivedArtifact | null)[];
	importLegacyResult?: DerivedArtifact | null;
	legacyText?: string | null;
	sourceVerification?: { valid: boolean; evidence: ArtifactEvidence[]; evidenceGeneration: number };
	synthesisError?: Error;
};

function serviceHarness(config: HarnessConfig = {}) {
	const state = {
		publishCalls: 0,
		candidateWrites: 0,
		importLegacyCalls: 0,
		legacyReadCalls: 0,
		legacySelfBackfillCalls: 0,
		restoreCalls: 0,
		synthesisCalls: 0,
		synthesisEvidence: [] as unknown[],
		failures: [] as {
			userId: string;
			kind: string;
			reasonCode: string;
			watermark: string | null;
		}[],
		rebuildFailures: [] as {
			userId: string;
			kind: string;
			reasonCode: string;
			now: string;
		}[],
		getCalls: [] as { userId: string; artifactId: string }[],
		restoredFromId: null as string | null,
		active: config.active ?? null,
	};
	const gen = config.currentEvidenceGeneration ?? 0;
	const activeReads = [...(config.activeReads ?? [])];

	const store = {
		async getEvidenceGeneration() {
			return gen;
		},
		async getActiveArtifact() {
			return state.active;
		},
		async readActiveArtifact() {
			return activeReads.length ? activeReads.shift()! : state.active;
		},
		async getArtifactById(userId: string, artifactId: string) {
			state.getCalls.push({ userId, artifactId });
			return config.artifactById ?? null;
		},
		async getArtifactDetail(userId: string, artifactId: string) {
			state.getCalls.push({ userId, artifactId });
			return config.artifactById ? { artifact: config.artifactById, sources: [], events: [] } : null;
		},
		async listArtifacts() {
			return { items: config.candidate ? [config.candidate] : [], nextCursor: null };
		},
		async createArtifactCandidate(_userId: string, draft: { evidence: unknown[] }) {
			state.candidateWrites += 1;
			state.synthesisEvidence = draft.evidence;
			return config.nextCandidate ?? artifact({ id: "new-candidate", status: "candidate", kind: config.kind });
		},
		async publishArtifact(_userId: string, artifactId: string) {
			state.publishCalls += 1;
			return artifact({ id: artifactId, status: "published", kind: config.kind });
		},
		async rejectArtifact(_userId: string, artifactId: string) {
			return artifact({ id: artifactId, status: "rejected", kind: config.kind });
		},
		async restoreHistoricalArtifact(_userId: string, historicalId: string) {
			state.restoreCalls += 1;
			state.restoredFromId = historicalId;
			return config.nextCandidate
				? artifact({ ...config.nextCandidate, status: "published" })
				: artifact({ id: "restored", status: "published", kind: config.kind });
		},
		async recordArtifactFailure(
			userId: string,
			kind: string,
			reasonCode: string,
			watermark: string | null,
		) {
			state.failures.push({ userId, kind, reasonCode, watermark });
		},
		async getLegacyImportState() {
			return config.legacyImportState ?? null;
		},
		async importLegacyArtifact() {
			state.importLegacyCalls += 1;
			return config.importLegacyResult ?? null;
		},
	};

	const deps = {
		store: store as never,
		now: () => new Date(FIXED_NOW),
		recordArtifactRebuildFailure: async (
			userId: string,
			kind: "living_summary",
			reasonCode: string,
			now: Date,
		) => {
			state.rebuildFailures.push({
				userId,
				kind,
				reasonCode,
				now: now.toISOString(),
			});
		},
		countActiveProfileFacts: async () => config.memory?.eligibleCount ?? 0,
		ensureLegacySelfProfileFacts: async () => {
			state.legacySelfBackfillCalls += 1;
			return { imported: 0, skipped: 0 };
		},
		listActiveProfileFacts: async () =>
			(config.memory?.evidence ?? [])
				.filter((item) => item.kind === "profile_fact")
				.map((item) => ({
					id: item.id,
					userId: "u1",
					section: "identity" as const,
					field: "f",
					value: "v",
					confidence: 1,
					source_type: "stated" as const,
					source_id: null,
					status: "active" as const,
					supersedes_id: null,
					verified_at: item.updatedAt,
					created_at: item.updatedAt,
					updated_at: item.updatedAt,
				})),
		collectMemoryEvidence: async () => ({
			evidence: (config.memory?.evidence ?? []).filter((item) => item.kind !== "profile_fact"),
			eligibleCount: config.memory?.eligibleCount ?? 0,
		}),
		collectBehaviorEvidence: async () => ({
			evidence: config.memory?.evidence ?? [],
			eligibleCount: config.memory?.eligibleCount ?? 0,
		}),
		readLegacy: async () => {
			state.legacyReadCalls += 1;
			return config.legacyText ?? null;
		},
		verifyHistoricalSources: async () =>
			config.sourceVerification ?? { valid: false, evidence: [], evidenceGeneration: gen },
		synthesis: {
			model: "test-model",
			now: () => "2026-07-25T00:00:00.000Z",
			callModel: async (_system: string, user: string) => {
				state.synthesisCalls += 1;
				if (config.synthesisError) throw config.synthesisError;
				const match = user.match(/<untrusted_evidence_json>\n([\s\S]*)\n<\/untrusted_evidence_json>/);
				const payload = JSON.parse(match![1]) as {
					artifact_kind: ArtifactKind;
					evidence: { source_kind: string; source_id: string; section: string; source_type: string }[];
				};
				const first = payload.evidence[0];
				const section =
					payload.artifact_kind === "self_profile"
						? "identity"
						: payload.artifact_kind === "behavioral_profile"
							? "communication_style"
							: first.section;
				return JSON.stringify({
					claims: [
						{
							section,
							text: "A concise validated fact.",
							confidence: 0.9,
							provenance: first.source_type === "stated" ? "stated" : "observed",
							sensitivity: "normal",
							citations: [{ source_kind: first.source_kind, source_id: first.source_id }],
						},
					],
				});
			},
		},
	};
	return Object.assign(state, { deps });
}

test("rebuild publishes a living summary", async () => {
	const harness = serviceHarness({
		memory: { evidence: [evidence()], eligibleCount: 1 },
		kind: "living_summary",
	});
	const result = await createArtifactService({} as Env, harness.deps).rebuildDerivedArtifact(
		"u1",
		"living_summary",
	);
	assert.equal(result.published, true);
	assert.equal(harness.publishCalls, 1);
});

test("self rebuild backfills legacy facts and stays a candidate", async () => {
	const harness = serviceHarness({
		memory: { evidence: [evidence({ kind: "profile_fact", id: "f1" })], eligibleCount: 1 },
		kind: "self_profile",
	});
	const result = await createArtifactService({} as Env, harness.deps).rebuildDerivedArtifact(
		"u1",
		"self_profile",
	);
	assert.equal(harness.legacySelfBackfillCalls >= 1, true);
	assert.equal(result.artifact.status, "candidate");
	assert.equal(result.published, false);
	assert.equal(harness.publishCalls, 0);
});

test("behavioral rebuild never publishes", async () => {
	const harness = serviceHarness({
		memory: {
			evidence: [
				evidence({ kind: "behavioral_observation", id: "o1", sourceType: "observed", observationType: "communication", section: "communication_style" }),
			],
			eligibleCount: 1,
		},
		kind: "behavioral_profile",
	});
	const result = await createArtifactService({} as Env, harness.deps).rebuildDerivedArtifact(
		"u1",
		"behavioral_profile",
	);
	assert.equal(result.artifact.status, "candidate");
	assert.equal(result.published, false);
	assert.equal(harness.publishCalls, 0);
});

test("empty eligible evidence fails before synthesis and preserves active state", async () => {
	const harness = serviceHarness({
		memory: { evidence: [], eligibleCount: 0 },
		active: artifact({ id: "current", status: "published" }),
	});
	await assert.rejects(
		createArtifactService({} as Env, harness.deps).rebuildDerivedArtifact("u1", "living_summary"),
		/no_eligible_evidence/,
	);
	assert.equal(harness.synthesisCalls, 0);
	assert.equal(harness.active?.id, "current");
	assert.equal(harness.candidateWrites, 0);
	// The persistent rebuild-state writer is the single failure authority for
	// living summaries; the content-free event-only writer must stay unused.
	assert.deepEqual(harness.rebuildFailures, [
		{
			userId: "u1",
			kind: "living_summary",
			reasonCode: "no_eligible_evidence",
			now: FIXED_NOW,
		},
	]);
	assert.deepEqual(harness.failures, []);
});

test("a living synthesis failure takes the same single rebuild-state write path", async () => {
	const harness = serviceHarness({
		memory: { evidence: [evidence()], eligibleCount: 1 },
		kind: "living_summary",
		synthesisError: new Error("model_timeout"),
	});
	await assert.rejects(
		createArtifactService({} as Env, harness.deps).rebuildDerivedArtifact("u1", "living_summary"),
		/model_timeout/,
	);
	assert.deepEqual(harness.rebuildFailures, [
		{
			userId: "u1",
			kind: "living_summary",
			reasonCode: "model_timeout",
			now: FIXED_NOW,
		},
	]);
	assert.deepEqual(harness.failures, []);
});

test("a living publication failure records exactly one rebuild-state write", async () => {
	const harness = serviceHarness({
		memory: { evidence: [evidence()], eligibleCount: 1 },
		kind: "living_summary",
	});
	harness.deps.store.publishArtifact = async () => {
		throw new Error("d1_failure");
	};
	await assert.rejects(
		createArtifactService({} as Env, harness.deps).rebuildDerivedArtifact("u1", "living_summary"),
		/d1_failure/,
	);
	assert.equal(harness.rebuildFailures.length, 1);
	assert.equal(harness.rebuildFailures[0].reasonCode, "d1_failure");
	assert.deepEqual(harness.failures, []);
});

test("self and behavioural failures write only the content-free artifact event", async () => {
	const self = serviceHarness({
		memory: { evidence: [evidence({ kind: "profile_fact", id: "f1" })], eligibleCount: 1 },
		kind: "self_profile",
		synthesisError: new Error("invalid_model_output"),
	});
	await assert.rejects(
		createArtifactService({} as Env, self.deps).rebuildDerivedArtifact("u1", "self_profile"),
		/invalid_model_output/,
	);
	assert.equal(self.failures.length, 1);
	assert.equal(self.failures[0].kind, "self_profile");
	assert.equal(self.failures[0].reasonCode, "invalid_model_output");
	assert.equal(typeof self.failures[0].watermark, "string");
	assert.deepEqual(self.rebuildFailures, []);

	const behavioral = serviceHarness({
		memory: { evidence: [], eligibleCount: 0 },
		kind: "behavioral_profile",
	});
	await assert.rejects(
		createArtifactService({} as Env, behavioral.deps).rebuildDerivedArtifact(
			"u1",
			"behavioral_profile",
		),
		/no_eligible_evidence/,
	);
	assert.deepEqual(behavioral.failures, [
		{
			userId: "u1",
			kind: "behavioral_profile",
			reasonCode: "no_eligible_evidence",
			watermark: behavioral.failures[0]?.watermark ?? null,
		},
	]);
	assert.deepEqual(behavioral.rebuildFailures, []);
});

test("successful living publication records no rebuild-state failure", async () => {
	const harness = serviceHarness({
		memory: { evidence: [evidence()], eligibleCount: 1 },
		kind: "living_summary",
	});
	const result = await createArtifactService({} as Env, harness.deps).rebuildDerivedArtifact(
		"u1",
		"living_summary",
	);
	assert.equal(result.published, true);
	assert.deepEqual(harness.rebuildFailures, []);
	assert.deepEqual(harness.failures, []);
});

test("review requires a reason for rejection and refuses approval after watermark drift", async () => {
	const harness = serviceHarness({
		artifactById: artifact({
			id: "candidate-1",
			kind: "self_profile",
			status: "candidate",
			source_watermark: "old-watermark",
		}),
		memory: { evidence: [evidence({ kind: "profile_fact", id: "f1" })], eligibleCount: 1 },
		kind: "self_profile",
	});
	const service = createArtifactService({} as Env, harness.deps);
	await assert.rejects(
		service.reviewDerivedArtifact("candidate-1", "u1", "reject", undefined, "user"),
		/reason is required for rejection/,
	);
	await assert.rejects(
		service.reviewDerivedArtifact("candidate-1", "u1", "approve", undefined, "user"),
		/Evidence changed; rebuild the candidate/,
	);
	assert.equal(harness.publishCalls, 0);
});

test("active resolution imports legacy exactly once", async () => {
	const imported = artifact({
		id: "legacy-import",
		status: "stale",
		validation_state: "legacy_unverified",
		rendered_text: "Legacy summary",
	});
	const harness = serviceHarness({
		activeReads: [null, imported],
		legacyImportState: null,
		importLegacyResult: imported,
		legacyText: "Legacy summary",
	});
	const service = createArtifactService({} as Env, harness.deps);
	const first = await service.resolveActiveDerivedArtifact("u1", "living_summary");
	const second = await service.resolveActiveDerivedArtifact("u1", "living_summary");
	assert.equal(first?.rendered_text, "Legacy summary");
	assert.equal(second?.id, first?.id);
	assert.equal(harness.importLegacyCalls, 1);
});

test("retired legacy state prevents reading a retained legacy key", async () => {
	const harness = serviceHarness({
		activeReads: [null],
		legacyImportState: "retired",
		legacyText: "Forgotten legacy summary",
	});
	const result = await createArtifactService({} as Env, harness.deps).resolveActiveDerivedArtifact(
		"u1",
		"living_summary",
	);
	assert.equal(result, null);
	assert.equal(harness.legacyReadCalls, 0);
	assert.equal(harness.importLegacyCalls, 0);
});

test("tenant-scoped get never returns another tenant artifact", async () => {
	const harness = serviceHarness({ artifactById: null });
	const service = createArtifactService({} as Env, harness.deps);
	assert.equal(await service.getDerivedArtifact("u2-artifact", "u1"), null);
	assert.deepEqual(harness.getCalls, [{ userId: "u1", artifactId: "u2-artifact" }]);
});

test("restore clones valid historical content into a new published version", async () => {
	const rendered = "## projects\n- Project Atlas is active. [memory:m1]";
	const historical = artifact({
		id: "historical",
		kind: "living_summary",
		version: 2,
		status: "superseded",
		published_at: "2026-07-23T00:00:00.000Z",
		validation_state: "validated",
		claims: [CLAIM],
		rendered_text: rendered,
		content_sha256: await artifactContentSha256([CLAIM], rendered),
	});
	const harness = serviceHarness({
		artifactById: historical,
		sourceVerification: { valid: true, evidence: [evidence()], evidenceGeneration: 3 },
		nextCandidate: artifact({ id: "restored-candidate", version: 5, status: "candidate", kind: "living_summary" }),
		kind: "living_summary",
	});
	const restored = await createArtifactService({} as Env, harness.deps).restoreDerivedArtifact(
		"historical",
		"u1",
		"Restore the last verified wording",
		"user",
	);
	assert.equal(restored.id, "restored-candidate");
	assert.equal(restored.status, "published");
	assert.equal(harness.restoredFromId, "historical");
});

test("restore rejects unapproved, legacy-unverified, and uncited historical artifacts", async () => {
	const rendered = "## projects\n- Project Atlas is active. [memory:m1]";
	const hash = await artifactContentSha256([CLAIM], rendered);

	const unapproved = serviceHarness({
		artifactById: artifact({ id: "cand", status: "candidate", published_at: null, claims: [CLAIM], rendered_text: rendered, content_sha256: hash }),
	});
	await assert.rejects(
		createArtifactService({} as Env, unapproved.deps).restoreDerivedArtifact("cand", "u1", "x", "user"),
		/Only previously published artifacts can be restored/,
	);

	const legacy = serviceHarness({
		artifactById: artifact({ id: "legacy", status: "stale", published_at: "2026-07-22T00:00:00.000Z", validation_state: "legacy_unverified", claims: [CLAIM], rendered_text: rendered, content_sha256: hash }),
	});
	await assert.rejects(
		createArtifactService({} as Env, legacy.deps).restoreDerivedArtifact("legacy", "u1", "x", "user"),
		/Legacy-unverified content cannot be restored/,
	);

	const uncited = serviceHarness({
		artifactById: artifact({ id: "uncited", status: "superseded", published_at: "2026-07-21T00:00:00.000Z", validation_state: "validated", claims: [CLAIM], rendered_text: rendered, content_sha256: hash }),
		sourceVerification: { valid: false, evidence: [], evidenceGeneration: 3 },
	});
	await assert.rejects(
		createArtifactService({} as Env, uncited.deps).restoreDerivedArtifact("uncited", "u1", "x", "user"),
		/Historical evidence is missing or changed/,
	);
	assert.equal(unapproved.restoreCalls + legacy.restoreCalls + uncited.restoreCalls, 0);
});

test("a reused living candidate publishes while a reused profile candidate stays pending", async () => {
	const livingEvidence = [evidence()];
	const livingPack = await selectArtifactEvidence("living_summary", livingEvidence, 1);
	const living = serviceHarness({
		memory: { evidence: livingEvidence, eligibleCount: 1 },
		candidate: artifact({ id: "living-candidate", kind: "living_summary", status: "candidate", validation_state: "validated", source_watermark: livingPack.watermark }),
		kind: "living_summary",
	});
	assert.equal(
		(await createArtifactService({} as Env, living.deps).rebuildDerivedArtifact("u1", "living_summary")).published,
		true,
	);
	assert.equal(living.publishCalls, 1);

	const selfEvidence = [evidence({ kind: "profile_fact", id: "f1" })];
	const selfFacts = [
		{
			id: "f1",
			userId: "u1",
			section: "identity" as const,
			field: "f",
			value: "v",
			confidence: 1,
			source_type: "stated" as const,
			source_id: null,
			status: "active" as const,
			supersedes_id: null,
			verified_at: "2026-07-24T00:00:00.000Z",
			created_at: "2026-07-24T00:00:00.000Z",
			updated_at: "2026-07-24T00:00:00.000Z",
		},
	];
	// derive the same profile_fact evidence the service will build, to match the watermark
	const { canonicalJson: cj, sha256Hex: sh } = await import("../src/utils/artifact-synthesis");
	const factEvidence: ArtifactEvidence[] = await Promise.all(
		selfFacts.map(async (f) => ({
			kind: "profile_fact" as const,
			id: f.id,
			text: `${f.section}.${f.field}: ${f.value}`,
			sourceSha256: await sh(
				cj({
					id: f.id,
					section: f.section,
					field: f.field,
					value: f.value,
					confidence: f.confidence,
					source_type: f.source_type,
					source_id: f.source_id,
					status: f.status,
					verified_at: f.verified_at,
					updated_at: f.updated_at,
				}),
			),
			section: f.section,
			updatedAt: f.updated_at,
			status: "active" as const,
			sourceType: "stated" as const,
			verified: true,
			confidence: 1,
			salience: 1,
			pinned: false,
			core: true,
		})),
	);
	const selfPack = await selectArtifactEvidence("self_profile", factEvidence, 1);
	const profile = serviceHarness({
		memory: { evidence: selfEvidence, eligibleCount: 1 },
		candidate: artifact({ id: "self-candidate", kind: "self_profile", status: "candidate", validation_state: "validated", source_watermark: selfPack.watermark }),
		kind: "self_profile",
	});
	assert.equal(
		(await createArtifactService({} as Env, profile.deps).rebuildDerivedArtifact("u1", "self_profile")).published,
		false,
	);
	assert.equal(profile.publishCalls, 0);
});
