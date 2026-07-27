import {
	ARTIFACT_FAILURE_CODES,
	type ArtifactDraft,
	type ArtifactEvidence,
	type ArtifactFailureCode,
	type ArtifactKind,
	type ArtifactStatus,
	type DerivedArtifact,
	type DerivedArtifactDetail,
	type ProfileFact,
} from "../types";
import {
	createD1ArtifactStore,
	recordArtifactRebuildFailure,
	type ArtifactStore,
} from "./artifact-store";
import {
	ARTIFACT_PROMPT_VERSION,
	artifactContentSha256,
	canonicalJson,
	selectArtifactEvidence,
	sha256Hex,
	synthesizeArtifact,
	type SynthesisDependencies,
} from "./artifact-synthesis";
import {
	countActiveProfileFacts,
	ensureLegacySelfProfileFacts,
	listActiveProfileFacts,
} from "./profile-facts";
import {
	getBehavioralCache,
	getLivingSummary as getLegacyLivingSummary,
} from "./kv";
import { readStaticFile } from "./static-context";

export type ListDerivedArtifactsInput = {
	kind?: ArtifactKind;
	status?: ArtifactStatus;
	cursor?: string;
	limit?: number;
};

export type ListDerivedArtifactsResult = {
	items: DerivedArtifact[];
	nextCursor: string | null;
};

export type ArtifactRebuildResult = {
	artifact: DerivedArtifact;
	reused: boolean;
	published: boolean;
};

type RawEvidenceCollection = {
	evidence: ArtifactEvidence[];
	eligibleCount: number;
};

type EvidenceCollection = RawEvidenceCollection & {
	evidenceGeneration: number;
};

export type ArtifactServiceDependencies = {
	store: ArtifactStore;
	synthesis?: Partial<SynthesisDependencies>;
	now(): Date;
	recordArtifactRebuildFailure: typeof recordArtifactRebuildFailure;
	countActiveProfileFacts: typeof countActiveProfileFacts;
	ensureLegacySelfProfileFacts: typeof ensureLegacySelfProfileFacts;
	listActiveProfileFacts: typeof listActiveProfileFacts;
	collectMemoryEvidence(
		userId: string,
		categories: readonly string[] | undefined,
		env: Env,
	): Promise<RawEvidenceCollection>;
	collectBehaviorEvidence(userId: string, env: Env): Promise<RawEvidenceCollection>;
	readLegacy(userId: string, kind: ArtifactKind, env: Env): Promise<string | null>;
	verifyHistoricalSources(
		userId: string,
		artifact: DerivedArtifact,
		env: Env,
	): Promise<{
		valid: boolean;
		evidence: ArtifactEvidence[];
		evidenceGeneration: number;
	}>;
};

const MAX_SOURCE_CONTENT_BYTES = 4_096;
const MAX_MEMORY_CANDIDATE_ROWS = 180;
const MAX_BEHAVIOR_OBSERVATION_ROWS = 180;
const MAX_BEHAVIOR_FEEDBACK_ROWS = 30;

async function memoryEvidence(
	row: Record<string, unknown>,
): Promise<ArtifactEvidence> {
	const canonicalSource = canonicalJson({
		id: row.id,
		text: row.text,
		category: row.category,
		layer: row.layer,
		source_type: row.source_type,
		last_verified: row.last_verified,
		confidence: row.confidence,
		salience: row.salience,
		pinned: row.pinned,
		suppressed: row.suppressed,
		updated_at: row.updated_at,
	});
	return {
		kind: "memory",
		id: String(row.id),
		updatedAt: String(row.updated_at),
		status: Number(row.suppressed) ? "suppressed" : "active",
		text: String(row.text).slice(0, 400),
		sourceSha256: await sha256Hex(canonicalSource),
		section: String(row.category),
		sourceType: String(row.source_type) as ArtifactEvidence["sourceType"],
		verified: row.last_verified !== null,
		confidence: Number(row.confidence),
		salience: Number(row.salience),
		pinned: Boolean(row.pinned),
		core: String(row.layer) === "core",
	};
}

async function behavioralObservationEvidence(
	row: Record<string, unknown>,
): Promise<ArtifactEvidence> {
	const canonicalSource = canonicalJson({
		id: row.id,
		observation_type: row.observation_type,
		content: row.content,
		context: row.context,
		source_type: row.source_type,
		confidence: row.confidence,
		status: row.status,
		verified_at: row.verified_at,
		created_at: row.created_at,
	});
	return {
		kind: "behavioral_observation",
		id: String(row.id),
		text: String(row.content).slice(0, 400),
		sourceSha256: await sha256Hex(canonicalSource),
		section: String(row.observation_type),
		updatedAt: String(row.created_at),
		status: String(row.status) as ArtifactEvidence["status"],
		sourceType: String(row.source_type) as ArtifactEvidence["sourceType"],
		verified: row.verified_at !== null,
		confidence: Number(row.confidence),
		salience: 0.5,
		pinned: false,
		core: false,
		observationType: String(row.observation_type),
	};
}

async function personalityFeedbackEvidence(
	row: Record<string, unknown>,
): Promise<ArtifactEvidence> {
	const canonicalSource = canonicalJson({
		id: row.id,
		persona: row.persona,
		tone: row.tone,
		mode: row.mode,
		situation: row.situation,
		outcome: row.outcome,
		feedback_score: row.feedback_score,
		created_at: row.created_at,
	});
	return {
		kind: "personality_feedback",
		id: String(row.id),
		text: canonicalSource.slice(0, 400),
		sourceSha256: await sha256Hex(canonicalSource),
		section: "personality_feedback",
		updatedAt: String(row.created_at),
		status: "active",
		sourceType: "stated",
		verified: true,
		confidence: 1,
		salience: Math.min(1, Math.abs(Number(row.feedback_score ?? 0))),
		pinned: false,
		core: false,
	};
}

async function profileFactEvidence(fact: ProfileFact): Promise<ArtifactEvidence> {
	const canonicalSource = canonicalJson({
		id: fact.id,
		section: fact.section,
		field: fact.field,
		value: fact.value,
		confidence: fact.confidence,
		source_type: fact.source_type,
		source_id: fact.source_id,
		status: fact.status,
		verified_at: fact.verified_at,
		updated_at: fact.updated_at,
	});
	return {
		kind: "profile_fact",
		id: fact.id,
		text: `${fact.section}.${fact.field}: ${fact.value ?? ""}`.slice(0, 400),
		sourceSha256: await sha256Hex(canonicalSource),
		section: fact.section,
		updatedAt: fact.updated_at,
		status: fact.status,
		sourceType: fact.source_type,
		verified: Boolean(fact.verified_at),
		confidence: fact.confidence,
		salience: 1,
		pinned: false,
		core: true,
	};
}

function memoryCategoryClause(categories: readonly string[] | undefined): {
	sql: string;
	bindings: string[];
} {
	if (categories === undefined) return { sql: "", bindings: [] };
	const bindings = [...new Set(categories)].sort();
	if (bindings.length === 0) return { sql: " AND 0=1", bindings };
	return {
		sql: ` AND category IN (${bindings.map(() => "?").join(",")})`,
		bindings,
	};
}

async function collectMemoryEvidenceFromD1(
	userId: string,
	categories: readonly string[] | undefined,
	env: Env,
): Promise<RawEvidenceCollection> {
	const filter = memoryCategoryClause(categories);
	const count = await env.DB.prepare(
		`SELECT COUNT(*) AS count
		 FROM memories
		 WHERE userId=? AND suppressed=0
		   AND length(CAST(text AS BLOB))<=?${filter.sql}`,
	)
		.bind(userId, MAX_SOURCE_CONTENT_BYTES, ...filter.bindings)
		.first<{ count: number }>();
	const reserved = await env.DB.prepare(
		`SELECT id,text,category,layer,source_type,last_verified,confidence,
		        salience,pinned,suppressed,updated_at
		 FROM memories
		 WHERE userId=? AND suppressed=0
		   AND length(CAST(text AS BLOB))<=?
		   AND (pinned=1 OR layer='core')${filter.sql}
		 ORDER BY pinned DESC,
		          CASE WHEN last_verified IS NULL THEN 0 ELSE 1 END DESC,
		          salience DESC, updated_at DESC, id ASC
		 LIMIT 60`,
	)
		.bind(userId, MAX_SOURCE_CONTENT_BYTES, ...filter.bindings)
		.all();
	const ranked = await env.DB.prepare(
		`WITH ranked AS (
			SELECT id,text,category,layer,source_type,last_verified,confidence,
			       salience,pinned,suppressed,updated_at,
			       ROW_NUMBER() OVER (
			         PARTITION BY category
			         ORDER BY CASE WHEN last_verified IS NULL THEN 0 ELSE 1 END DESC,
			                  salience DESC, updated_at DESC, id ASC
			       ) AS category_rank
			FROM memories
			WHERE userId=? AND suppressed=0
			  AND length(CAST(text AS BLOB))<=?
			  AND NOT (pinned=1 OR layer='core')${filter.sql}
		 )
		 SELECT id,text,category,layer,source_type,last_verified,confidence,
		        salience,pinned,suppressed,updated_at
		 FROM ranked
		 WHERE category_rank<=30
		 ORDER BY category_rank ASC,category ASC,id ASC
		 LIMIT ?`,
	)
		.bind(userId, MAX_SOURCE_CONTENT_BYTES, ...filter.bindings, MAX_MEMORY_CANDIDATE_ROWS)
		.all();
	const byId = new Map<string, Record<string, unknown>>();
	for (const row of [
		...(reserved.results as Record<string, unknown>[]),
		...(ranked.results as Record<string, unknown>[]),
	]) {
		if (!byId.has(String(row.id))) byId.set(String(row.id), row);
	}
	return {
		evidence: await Promise.all([...byId.values()].map(memoryEvidence)),
		eligibleCount: Number(count?.count ?? 0),
	};
}

async function collectBehaviorEvidenceFromD1(
	userId: string,
	env: Env,
): Promise<RawEvidenceCollection> {
	const observationBytes =
		"length(CAST(COALESCE(observation_type,'') AS BLOB))" +
		"+length(CAST(COALESCE(content,'') AS BLOB))" +
		"+length(CAST(COALESCE(context,'') AS BLOB))";
	const feedbackBytes =
		"length(CAST(COALESCE(persona,'') AS BLOB))" +
		"+length(CAST(COALESCE(tone,'') AS BLOB))" +
		"+length(CAST(COALESCE(mode,'') AS BLOB))" +
		"+length(CAST(COALESCE(situation,'') AS BLOB))" +
		"+length(CAST(COALESCE(outcome,'') AS BLOB))";
	const observationCount = await env.DB.prepare(
		`SELECT COUNT(*) AS count FROM behavioral_observations
		 WHERE userId=? AND status='active'
		   AND length(CAST(observation_type AS BLOB)) BETWEEN 1 AND 80
		   AND ${observationBytes}<=?`,
	)
		.bind(userId, MAX_SOURCE_CONTENT_BYTES)
		.first<{ count: number }>();
	const feedbackCount = await env.DB.prepare(
		`SELECT COUNT(*) AS count FROM personality_feedback
		 WHERE userId=? AND ${feedbackBytes}<=?`,
	)
		.bind(userId, MAX_SOURCE_CONTENT_BYTES)
		.first<{ count: number }>();
	const observations = await env.DB.prepare(
		`WITH ranked AS (
			SELECT id,observation_type,content,context,source_type,confidence,status,
			       verified_at,created_at,
			       ROW_NUMBER() OVER (
			         PARTITION BY observation_type ORDER BY created_at DESC,id ASC
			       ) AS type_rank
			FROM behavioral_observations
			WHERE userId=? AND status='active'
			  AND length(CAST(observation_type AS BLOB)) BETWEEN 1 AND 80
			  AND ${observationBytes}<=?
		 )
		 SELECT id,observation_type,content,context,source_type,confidence,status,
		        verified_at,created_at
		 FROM ranked WHERE type_rank<=30
		 ORDER BY type_rank ASC,observation_type ASC,id ASC
		 LIMIT ?`,
	)
		.bind(userId, MAX_SOURCE_CONTENT_BYTES, MAX_BEHAVIOR_OBSERVATION_ROWS)
		.all();
	const feedback = await env.DB.prepare(
		`SELECT id,persona,tone,mode,situation,outcome,feedback_score,created_at
		 FROM personality_feedback
		 WHERE userId=? AND ${feedbackBytes}<=?
		 ORDER BY created_at DESC,id ASC LIMIT ?`,
	)
		.bind(userId, MAX_SOURCE_CONTENT_BYTES, MAX_BEHAVIOR_FEEDBACK_ROWS)
		.all();
	const evidence = await Promise.all([
		...(observations.results as Record<string, unknown>[]).map(
			behavioralObservationEvidence,
		),
		...(feedback.results as Record<string, unknown>[]).map(
			personalityFeedbackEvidence,
		),
	]);
	return {
		evidence,
		eligibleCount:
			Number(observationCount?.count ?? 0) + Number(feedbackCount?.count ?? 0),
	};
}

async function defaultLegacyReader(
	userId: string,
	kind: ArtifactKind,
	env: Env,
): Promise<string | null> {
	if (kind === "living_summary") {
		return getLegacyLivingSummary(userId, env);
	}
	if (kind === "self_profile") {
		return readStaticFile(userId, "self_profile", env);
	}
	return getBehavioralCache(userId, env);
}

async function liveSourceEvidence(
	userId: string,
	sourceKind: ArtifactEvidence["kind"],
	sourceId: string,
	env: Env,
): Promise<ArtifactEvidence | null> {
	if (sourceKind === "memory") {
		const row = await env.DB.prepare(
			`SELECT id,text,category,layer,source_type,last_verified,confidence,
			        salience,pinned,suppressed,updated_at
			 FROM memories WHERE userId=? AND id=? AND suppressed=0`,
		)
			.bind(userId, sourceId)
			.first<Record<string, unknown>>();
		return row ? memoryEvidence(row) : null;
	}
	if (sourceKind === "behavioral_observation") {
		const row = await env.DB.prepare(
			`SELECT id,observation_type,content,context,source_type,confidence,status,
			        verified_at,created_at
			 FROM behavioral_observations WHERE userId=? AND id=? AND status='active'`,
		)
			.bind(userId, sourceId)
			.first<Record<string, unknown>>();
		return row ? behavioralObservationEvidence(row) : null;
	}
	if (sourceKind === "personality_feedback") {
		const row = await env.DB.prepare(
			`SELECT id,persona,tone,mode,situation,outcome,feedback_score,created_at
			 FROM personality_feedback WHERE userId=? AND id=?`,
		)
			.bind(userId, sourceId)
			.first<Record<string, unknown>>();
		return row ? personalityFeedbackEvidence(row) : null;
	}
	const row = await env.DB.prepare(
		`SELECT id,userId,section,field,value,confidence,source_type,source_id,
		        status,supersedes_id,verified_at,created_at,updated_at
		 FROM profile_facts WHERE userId=? AND id=? AND status='active'`,
	)
		.bind(userId, sourceId)
		.first<Record<string, unknown>>();
	if (!row) return null;
	return profileFactEvidence({
		id: String(row.id),
		userId: String(row.userId),
		section: row.section as ProfileFact["section"],
		field: String(row.field),
		value: row.value === null ? null : String(row.value),
		confidence: Number(row.confidence),
		source_type: "stated",
		source_id: row.source_id === null ? null : String(row.source_id),
		status: row.status as ProfileFact["status"],
		supersedes_id: row.supersedes_id === null ? null : String(row.supersedes_id),
		verified_at: String(row.verified_at),
		created_at: String(row.created_at),
		updated_at: String(row.updated_at),
	});
}

async function verifyHistoricalSourcesFromD1(
	userId: string,
	artifact: DerivedArtifact,
	env: Env,
): Promise<{
	valid: boolean;
	evidence: ArtifactEvidence[];
	evidenceGeneration: number;
}> {
	const generationOf = async () =>
		Number(
			(
				await env.DB.prepare(
					`SELECT COALESCE(generation,0) AS generation
					 FROM derived_artifact_evidence_state WHERE userId=? AND kind=?`,
				)
					.bind(userId, artifact.kind)
					.first<{ generation: number }>()
			)?.generation ?? 0,
		);
	const before = await generationOf();
	const links = await env.DB.prepare(
		`SELECT source_kind,source_id,source_updated_at,source_sha256
		 FROM derived_artifact_sources WHERE userId=? AND artifact_id=?
		 ORDER BY source_kind,source_id`,
	)
		.bind(userId, artifact.id)
		.all<{
			source_kind: ArtifactEvidence["kind"];
			source_id: string;
			source_updated_at: string;
			source_sha256: string;
		}>();
	const citations = new Set(
		artifact.claims.flatMap((claim) =>
			claim.citations.map((c) => `${c.source_kind}:${c.source_id}`),
		),
	);
	const bySource = new Map<string, (typeof links.results)[number]>();
	for (const link of links.results) {
		const key = `${link.source_kind}:${link.source_id}`;
		const existing = bySource.get(key);
		if (existing && existing.source_sha256 !== link.source_sha256) {
			return { valid: false, evidence: [], evidenceGeneration: before };
		}
		bySource.set(key, link);
	}
	if (
		bySource.size === 0 ||
		bySource.size > 120 ||
		links.results.length > 960 ||
		bySource.size !== citations.size ||
		[...bySource.keys()].some((key) => !citations.has(key))
	) {
		return { valid: false, evidence: [], evidenceGeneration: before };
	}
	const evidence: ArtifactEvidence[] = [];
	for (const [key, link] of bySource) {
		const live = await liveSourceEvidence(
			userId,
			link.source_kind,
			link.source_id,
			env,
		);
		if (
			!live ||
			live.sourceSha256 !== link.source_sha256 ||
			live.updatedAt !== link.source_updated_at
		) {
			return { valid: false, evidence: [], evidenceGeneration: before };
		}
		evidence.push(live);
		void key;
	}
	const after = await generationOf();
	if (after !== before) {
		return { valid: false, evidence: [], evidenceGeneration: after };
	}
	return { valid: true, evidence, evidenceGeneration: after };
}

function serviceDependencies(
	env: Env,
	overrides?: Partial<ArtifactServiceDependencies>,
): ArtifactServiceDependencies {
	return {
		store: createD1ArtifactStore(env),
		now: () => new Date(),
		recordArtifactRebuildFailure,
		countActiveProfileFacts,
		ensureLegacySelfProfileFacts,
		listActiveProfileFacts,
		collectMemoryEvidence: collectMemoryEvidenceFromD1,
		collectBehaviorEvidence: collectBehaviorEvidenceFromD1,
		readLegacy: defaultLegacyReader,
		verifyHistoricalSources: verifyHistoricalSourcesFromD1,
		...overrides,
	};
}

async function collectEvidence(
	userId: string,
	kind: ArtifactKind,
	env: Env,
	deps: ArtifactServiceDependencies,
): Promise<EvidenceCollection> {
	if (kind === "self_profile") {
		await deps.ensureLegacySelfProfileFacts(userId, env);
	}
	const before = await deps.store.getEvidenceGeneration(userId, kind);
	let raw: RawEvidenceCollection;
	if (kind === "living_summary") {
		raw = await deps.collectMemoryEvidence(userId, undefined, env);
	} else if (kind === "behavioral_profile") {
		raw = await deps.collectBehaviorEvidence(userId, env);
	} else {
		const [facts, factEligibleCount, memories] = await Promise.all([
			deps.listActiveProfileFacts(userId, env, 50, MAX_SOURCE_CONTENT_BYTES),
			deps.countActiveProfileFacts(userId, env, MAX_SOURCE_CONTENT_BYTES),
			deps.collectMemoryEvidence(
				userId,
				["identity", "preferences", "likes", "goals", "rules"],
				env,
			),
		]);
		const factEvidence = await Promise.all(facts.map(profileFactEvidence));
		raw = {
			evidence: [...factEvidence, ...memories.evidence],
			eligibleCount: factEligibleCount + memories.eligibleCount,
		};
	}
	const after = await deps.store.getEvidenceGeneration(userId, kind);
	if (before !== after) throw new Error("evidence_changed");
	return { ...raw, evidenceGeneration: after };
}

async function resolveActiveWithDependencies(
	userId: string,
	kind: ArtifactKind,
	env: Env,
	deps: ArtifactServiceDependencies,
): Promise<DerivedArtifact | null> {
	if (kind === "self_profile") {
		await deps.ensureLegacySelfProfileFacts(userId, env);
	}
	const active = await deps.store.readActiveArtifact(userId, kind);
	if (active) return active;
	if (await deps.store.getLegacyImportState(userId, kind)) return null;
	const legacy = await deps.readLegacy(userId, kind, env);
	if (!legacy) return null;
	return deps.store.importLegacyArtifact(userId, kind, legacy);
}

export function artifactFailureCode(error: unknown): ArtifactFailureCode {
	const candidate = error instanceof Error ? error.message : "";
	return ARTIFACT_FAILURE_CODES.includes(candidate as ArtifactFailureCode)
		? (candidate as ArtifactFailureCode)
		: "generation_failed";
}

async function rebuildWithDependencies(
	userId: string,
	kind: ArtifactKind,
	env: Env,
	deps: ArtifactServiceDependencies,
): Promise<ArtifactRebuildResult> {
	let failureWatermark: string | null = null;
	try {
		const collected = await collectEvidence(userId, kind, env, deps);
		const currentPack = await selectArtifactEvidence(
			kind,
			collected.evidence,
			collected.eligibleCount,
		);
		failureWatermark = currentPack.watermark;
		if (collected.eligibleCount === 0 || currentPack.sources.length === 0) {
			throw new Error("no_eligible_evidence");
		}
		const active = await deps.store.getActiveArtifact(userId, kind);
		if (
			active?.status === "published" &&
			active.source_watermark === currentPack.watermark &&
			active.evidence_generation === collected.evidenceGeneration &&
			active.prompt_version === ARTIFACT_PROMPT_VERSION
		) {
			return { artifact: active, reused: true, published: true };
		}
		const existing = (
			await deps.store.listArtifacts(userId, {
				kind,
				status: "candidate",
				limit: 50,
			})
		).items.find(
			(item) =>
				item.validation_state === "validated" &&
				item.source_watermark === currentPack.watermark &&
				item.evidence_generation === collected.evidenceGeneration &&
				item.prompt_version === ARTIFACT_PROMPT_VERSION,
		);
		if (existing) {
			if (kind === "living_summary") {
				const published = await deps.store.publishArtifact(
					userId,
					existing.id,
					"system",
				);
				return { artifact: published, reused: true, published: true };
			}
			return { artifact: existing, reused: true, published: false };
		}

		const draft = await synthesizeArtifact(
			kind,
			collected.evidence,
			collected.eligibleCount,
			env,
			deps.synthesis,
		);
		const refreshed = await collectEvidence(userId, kind, env, deps);
		const refreshedPack = await selectArtifactEvidence(
			kind,
			refreshed.evidence,
			refreshed.eligibleCount,
		);
		if (
			refreshedPack.watermark !== draft.sourceWatermark ||
			refreshed.evidenceGeneration !== collected.evidenceGeneration
		) {
			throw new Error("evidence_changed");
		}
		const candidate = await deps.store.createArtifactCandidate(
			userId,
			draft,
			refreshed.evidenceGeneration,
		);
		if (kind !== "living_summary") {
			return { artifact: candidate, reused: false, published: false };
		}
		const published = await deps.store.publishArtifact(userId, candidate.id, "system");
		return { artifact: published, reused: false, published: true };
	} catch (error) {
		const reasonCode = artifactFailureCode(error);
		if (kind === "living_summary") {
			await deps.recordArtifactRebuildFailure(
				userId,
				kind,
				reasonCode,
				deps.now(),
				env,
			);
		} else {
			await deps.store.recordArtifactFailure(
				userId,
				kind,
				reasonCode,
				failureWatermark,
			);
		}
		throw error;
	}
}

async function getWithDependencies(
	artifactId: string,
	userId: string,
	_env: Env,
	deps: ArtifactServiceDependencies,
): Promise<DerivedArtifactDetail | null> {
	return deps.store.getArtifactDetail(userId, artifactId);
}

function base64UrlEncode(value: string): string {
	return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): string {
	let padded = value.replace(/-/g, "+").replace(/_/g, "/");
	while (padded.length % 4 !== 0) padded += "=";
	return atob(padded);
}

function encodeCursor(cursor: { createdAt: string; id: string } | null): string | null {
	if (!cursor) return null;
	return base64UrlEncode(JSON.stringify({ createdAt: cursor.createdAt, id: cursor.id }));
}

function decodeCursor(
	cursor: string | undefined,
): { createdAt: string; id: string } | undefined {
	if (cursor === undefined) return undefined;
	try {
		const parsed = JSON.parse(base64UrlDecode(cursor)) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("bad cursor");
		}
		const keys = Object.keys(parsed);
		if (keys.length !== 2 || !keys.includes("createdAt") || !keys.includes("id")) {
			throw new Error("bad cursor");
		}
		const { createdAt, id } = parsed as { createdAt: unknown; id: unknown };
		if (typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt))) {
			throw new Error("bad cursor");
		}
		if (typeof id !== "string" || id.length < 1 || id.length > 200) {
			throw new Error("bad cursor");
		}
		return { createdAt, id };
	} catch {
		throw new Error("Invalid pagination cursor");
	}
}

async function listWithDependencies(
	userId: string,
	input: ListDerivedArtifactsInput,
	_env: Env,
	deps: ArtifactServiceDependencies,
): Promise<ListDerivedArtifactsResult> {
	const limit = Math.min(Math.max(Math.trunc(input.limit ?? 20), 1), 50);
	const cursor = decodeCursor(input.cursor);
	const page = await deps.store.listArtifacts(userId, {
		kind: input.kind,
		status: input.status,
		limit,
		cursor,
	});
	return { items: page.items, nextCursor: encodeCursor(page.nextCursor) };
}

async function reviewWithDependencies(
	artifactId: string,
	userId: string,
	action: "approve" | "reject",
	reasonInput: string | undefined,
	actor: string,
	env: Env,
	deps: ArtifactServiceDependencies,
): Promise<DerivedArtifact> {
	const artifact = await deps.store.getArtifactById(userId, artifactId);
	if (!artifact) throw new Error("Artifact not found");
	if (artifact.status !== "candidate") {
		throw new Error("Only candidates can be reviewed");
	}
	if (artifact.validation_state !== "validated") {
		throw new Error("Only validated candidates can be reviewed");
	}
	if (artifact.kind !== "self_profile" && artifact.kind !== "behavioral_profile") {
		throw new Error("Living summaries publish through rebuild");
	}
	if (action === "reject") {
		const reason = reasonInput?.trim();
		if (!reason) throw new Error("reason is required for rejection");
		return deps.store.rejectArtifact(userId, artifact.id, reason, actor);
	}

	const current = await collectEvidence(userId, artifact.kind, env, deps);
	if (
		(await selectArtifactEvidence(artifact.kind, current.evidence, current.eligibleCount))
			.watermark !== artifact.source_watermark ||
		current.evidenceGeneration !== artifact.evidence_generation
	) {
		throw new Error("Evidence changed; rebuild the candidate");
	}
	return deps.store.publishArtifact(userId, artifact.id, actor);
}

async function artifactDraftFromHistorical(
	historical: DerivedArtifact & {
		rendered_text: string;
		model: string;
		source_watermark: string;
		content_sha256: string;
	},
	evidence: ArtifactEvidence[],
	reason: string,
): Promise<ArtifactDraft> {
	const contentSha256 = await artifactContentSha256(
		historical.claims,
		historical.rendered_text,
	);
	if (contentSha256 !== historical.content_sha256) {
		throw new Error("Historical artifact content is unavailable");
	}
	return {
		kind: historical.kind,
		claims: historical.claims,
		renderedText: historical.rendered_text,
		sourceWatermark: historical.source_watermark,
		eligibleSourceCount: historical.eligible_source_count,
		selectedSourceCount: historical.selected_source_count,
		sourceTruncated: historical.source_truncated,
		contentSha256,
		model: historical.model,
		promptVersion: historical.prompt_version,
		validation: {
			...historical.validation,
			restored_from: historical.id,
			restoration_reason: reason,
		},
		evidence,
	};
}

async function restoreWithDependencies(
	artifactId: string,
	userId: string,
	reasonInput: string,
	actor: string,
	env: Env,
	deps: ArtifactServiceDependencies,
): Promise<DerivedArtifact> {
	const reason = reasonInput.trim();
	if (!reason) throw new Error("reason is required");
	const historical = await deps.store.getArtifactById(userId, artifactId);
	if (!historical) throw new Error("Artifact not found");
	if (historical.status === "tombstoned") {
		throw new Error("Tombstoned content cannot be restored");
	}
	if (
		!["published", "stale", "superseded"].includes(historical.status) ||
		historical.published_at === null
	) {
		throw new Error("Only previously published artifacts can be restored");
	}
	if (historical.validation_state !== "validated") {
		throw new Error("Legacy-unverified content cannot be restored");
	}
	if (
		historical.claims.length === 0 ||
		!historical.rendered_text ||
		!historical.model ||
		!historical.source_watermark ||
		!historical.content_sha256
	) {
		throw new Error("Historical artifact content is unavailable");
	}
	const restorable = historical as DerivedArtifact & {
		rendered_text: string;
		model: string;
		source_watermark: string;
		content_sha256: string;
	};
	const historicalContentSha256 = await artifactContentSha256(
		restorable.claims,
		restorable.rendered_text,
	);
	if (historicalContentSha256 !== restorable.content_sha256) {
		throw new Error("Historical artifact content is unavailable");
	}
	const verification = await deps.verifyHistoricalSources(userId, restorable, env);
	if (!verification.valid || verification.evidence.length === 0) {
		throw new Error("Historical evidence is missing or changed");
	}
	const draft = await artifactDraftFromHistorical(
		restorable,
		verification.evidence,
		reason,
	);
	return deps.store.restoreHistoricalArtifact(
		userId,
		restorable.id,
		draft,
		verification.evidenceGeneration,
		reason,
		actor,
	);
}

export function createArtifactService(
	env: Env,
	overrides?: Partial<ArtifactServiceDependencies>,
) {
	const deps = serviceDependencies(env, overrides);
	return {
		listDerivedArtifacts: (userId: string, input: ListDerivedArtifactsInput) =>
			listWithDependencies(userId, input, env, deps),
		getDerivedArtifact: (artifactId: string, userId: string) =>
			getWithDependencies(artifactId, userId, env, deps),
		reviewDerivedArtifact: (
			artifactId: string,
			userId: string,
			action: "approve" | "reject",
			reason: string | undefined,
			actor: string,
		) => reviewWithDependencies(artifactId, userId, action, reason, actor, env, deps),
		restoreDerivedArtifact: (
			artifactId: string,
			userId: string,
			reason: string,
			actor: string,
		) => restoreWithDependencies(artifactId, userId, reason, actor, env, deps),
		rebuildDerivedArtifact: (userId: string, kind: ArtifactKind) =>
			rebuildWithDependencies(userId, kind, env, deps),
		resolveActiveDerivedArtifact: (userId: string, kind: ArtifactKind) =>
			resolveActiveWithDependencies(userId, kind, env, deps),
	};
}

export async function listDerivedArtifacts(
	userId: string,
	env: Env,
	input: ListDerivedArtifactsInput,
): Promise<ListDerivedArtifactsResult> {
	return createArtifactService(env).listDerivedArtifacts(userId, input);
}

export async function getDerivedArtifact(
	artifactId: string,
	userId: string,
	env: Env,
): Promise<DerivedArtifactDetail | null> {
	return createArtifactService(env).getDerivedArtifact(artifactId, userId);
}

export async function reviewDerivedArtifact(
	artifactId: string,
	userId: string,
	action: "approve" | "reject",
	reason: string | undefined,
	actor: string,
	env: Env,
): Promise<DerivedArtifact> {
	return createArtifactService(env).reviewDerivedArtifact(
		artifactId,
		userId,
		action,
		reason,
		actor,
	);
}

export async function restoreDerivedArtifact(
	artifactId: string,
	userId: string,
	reason: string,
	actor: string,
	env: Env,
): Promise<DerivedArtifact> {
	return createArtifactService(env).restoreDerivedArtifact(
		artifactId,
		userId,
		reason,
		actor,
	);
}

export async function rebuildDerivedArtifact(
	userId: string,
	kind: ArtifactKind,
	env: Env,
): Promise<ArtifactRebuildResult> {
	return createArtifactService(env).rebuildDerivedArtifact(userId, kind);
}

export async function resolveActiveDerivedArtifact(
	userId: string,
	kind: ArtifactKind,
	env: Env,
): Promise<DerivedArtifact | null> {
	return createArtifactService(env).resolveActiveDerivedArtifact(userId, kind);
}
