import type {
	ArtifactClaim,
	ArtifactDraft,
	ArtifactFailureCode,
	ArtifactKind,
	ArtifactSourceKind,
	ArtifactStatus,
	DerivedArtifact,
	DerivedArtifactDetail,
	DerivedArtifactEvent,
	DerivedArtifactSource,
} from "../types";
import { ARTIFACT_FAILURE_CODES } from "../types";
import {
	artifactClaimsSchema,
	artifactContentSha256,
	canonicalJson,
	containsHardSecret,
	sha256Hex,
} from "./artifact-synthesis";
import {
	type ArtifactCacheEnvelope,
	deleteArtifactCache,
	getArtifactCache,
	putArtifactCache,
} from "./kv";

export type ArtifactListFilters = {
	kind?: ArtifactKind;
	status?: ArtifactStatus;
	limit?: number;
	cursor?: { createdAt: string; id: string };
};

export type ArtifactPage = {
	items: DerivedArtifact[];
	nextCursor: { createdAt: string; id: string } | null;
};

export type ArtifactStoreDependencies = {
	now(): string;
	id(): string;
};

export interface ArtifactStore {
	createArtifactCandidate(
		userId: string,
		draft: ArtifactDraft,
		evidenceGeneration: number,
	): Promise<DerivedArtifact>;
	getEvidenceGeneration(userId: string, kind: ArtifactKind): Promise<number>;
	getArtifactById(
		userId: string,
		artifactId: string,
	): Promise<DerivedArtifact | null>;
	getArtifactDetail(
		userId: string,
		artifactId: string,
	): Promise<DerivedArtifactDetail | null>;
	getActiveArtifact(
		userId: string,
		kind: ArtifactKind,
	): Promise<DerivedArtifact | null>;
	readActiveArtifact(
		userId: string,
		kind: ArtifactKind,
	): Promise<DerivedArtifact | null>;
	listArtifacts(
		userId: string,
		filters?: ArtifactListFilters,
	): Promise<ArtifactPage>;
	markArtifactStale(
		userId: string,
		kind: ArtifactKind,
		reasonCode: string,
		actor: string,
	): Promise<DerivedArtifact | null>;
	publishArtifact(
		userId: string,
		artifactId: string,
		actor: string,
	): Promise<DerivedArtifact>;
	rejectArtifact(
		userId: string,
		artifactId: string,
		reason: string,
		actor: string,
	): Promise<DerivedArtifact>;
	restoreHistoricalArtifact(
		userId: string,
		historicalArtifactId: string,
		draft: ArtifactDraft,
		evidenceGeneration: number,
		reason: string,
		actor: string,
	): Promise<DerivedArtifact>;
	recordArtifactFailure(
		userId: string,
		kind: ArtifactKind,
		reasonCode: ArtifactFailureCode,
		sourceWatermark: string | null,
	): Promise<void>;
	getLegacyImportState(
		userId: string,
		kind: ArtifactKind,
	): Promise<"imported" | "retired" | null>;
	importLegacyArtifact(
		userId: string,
		kind: ArtifactKind,
		text: string,
	): Promise<DerivedArtifact | null>;
}

type ArtifactRow = {
	id: string;
	userId: string;
	kind: ArtifactKind;
	version: number;
	status: ArtifactStatus;
	validation_state: "validated" | "legacy_unverified";
	content_json: string | null;
	rendered_text: string | null;
	source_watermark: string | null;
	evidence_generation: number;
	eligible_source_count: number;
	selected_source_count: number;
	source_truncated: number;
	content_sha256: string | null;
	model: string | null;
	prompt_version: string;
	validation_json: string;
	supersedes_id: string | null;
	created_at: string;
	published_at: string | null;
	reviewed_at: string | null;
	reviewed_by: string | null;
};

const MAX_ARTIFACT_SOURCE_LINKS = 80 * 12;
const MAX_ARTIFACT_UNIQUE_SOURCES = 120;
const MAX_SOURCE_REQUEST_JSON_BYTES = 64 * 1024;
const MAX_SOURCE_GUARD_JSON_BYTES = 1_500_000;

type SourceGuardBundle = {
	v: 1;
	sources: Array<{
		source_kind: ArtifactSourceKind;
		source_id: string;
		source_updated_at: string;
		source_sha256: string;
		canonical: Record<string, string | number | null>;
	}>;
	links: Array<{
		claim_id: string;
		source_kind: ArtifactSourceKind;
		source_id: string;
	}>;
};

const ARTIFACT_COLUMNS = `id,userId,kind,version,status,validation_state,content_json,
	rendered_text,source_watermark,evidence_generation,eligible_source_count,
	selected_source_count,source_truncated,content_sha256,model,prompt_version,
	validation_json,supersedes_id,created_at,published_at,reviewed_at,reviewed_by`;

function byteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

function rowToArtifact(row: ArtifactRow): DerivedArtifact {
	if (row.status === "tombstoned") {
		throw new Error("Refusing to expose tombstoned artifact content");
	}
	const content = row.content_json
		? (JSON.parse(row.content_json) as { claims?: unknown })
		: { claims: [] };
	const claims = artifactClaimsSchema.parse(content.claims ?? []) as ArtifactClaim[];
	const validation = row.validation_json
		? (JSON.parse(row.validation_json) as Record<string, unknown>)
		: {};
	return {
		id: row.id,
		userId: row.userId,
		kind: row.kind,
		version: row.version,
		status: row.status,
		validation_state: row.validation_state,
		claims,
		rendered_text: row.rendered_text,
		source_watermark: row.source_watermark,
		evidence_generation: row.evidence_generation,
		eligible_source_count: row.eligible_source_count,
		selected_source_count: row.selected_source_count,
		source_truncated: row.source_truncated !== 0,
		content_sha256: row.content_sha256,
		model: row.model,
		prompt_version: row.prompt_version,
		validation,
		supersedes_id: row.supersedes_id,
		created_at: row.created_at,
		published_at: row.published_at,
		reviewed_at: row.reviewed_at,
		reviewed_by: row.reviewed_by,
	};
}

const PREFLIGHT_SQL = `
WITH requested AS (
	SELECT json_extract(value,'$.source_kind') AS source_kind,
	       json_extract(value,'$.source_id') AS source_id
	FROM json_each(json(?))
)
SELECT r.source_kind AS source_kind, r.source_id AS source_id,
	CASE r.source_kind
		WHEN 'memory' THEN (SELECT json_object('id',m.id,'text',m.text,'category',m.category,
			'layer',m.layer,'source_type',m.source_type,'last_verified',m.last_verified,
			'confidence',m.confidence,'salience',m.salience,'pinned',m.pinned,
			'suppressed',m.suppressed,'updated_at',m.updated_at)
			FROM memories m WHERE m.userId=? AND m.id=r.source_id AND m.suppressed=0)
		WHEN 'profile_fact' THEN (SELECT json_object('id',pf.id,'section',pf.section,
			'field',pf.field,'value',pf.value,'confidence',pf.confidence,
			'source_type',pf.source_type,'source_id',pf.source_id,'status',pf.status,
			'verified_at',pf.verified_at,'updated_at',pf.updated_at)
			FROM profile_facts pf WHERE pf.userId=? AND pf.id=r.source_id AND pf.status='active')
		WHEN 'behavioral_observation' THEN (SELECT json_object('id',b.id,
			'observation_type',b.observation_type,'content',b.content,'context',b.context,
			'source_type',b.source_type,'confidence',b.confidence,'status',b.status,
			'verified_at',b.verified_at,'created_at',b.created_at)
			FROM behavioral_observations b WHERE b.userId=? AND b.id=r.source_id AND b.status='active')
		WHEN 'personality_feedback' THEN (SELECT json_object('id',pfb.id,'persona',pfb.persona,
			'tone',pfb.tone,'mode',pfb.mode,'situation',pfb.situation,'outcome',pfb.outcome,
			'feedback_score',pfb.feedback_score,'created_at',pfb.created_at)
			FROM personality_feedback pfb WHERE pfb.userId=? AND pfb.id=r.source_id)
	END AS canonical_json
FROM requested r`;

const BULK_LINK_INSERT_SQL = `
INSERT INTO derived_artifact_sources
	(artifact_id,userId,claim_id,source_kind,source_id,source_updated_at,source_sha256,citation_role)
WITH
	guard_sources AS (
		SELECT json_extract(value,'$.source_kind') AS source_kind,
		       json_extract(value,'$.source_id') AS source_id,
		       json_extract(value,'$.source_updated_at') AS source_updated_at,
		       json_extract(value,'$.source_sha256') AS source_sha256,
		       json_extract(value,'$.canonical') AS canonical
		FROM json_each(json(?),'$.sources')
	),
	guard_links AS (
		SELECT json_extract(value,'$.claim_id') AS claim_id,
		       json_extract(value,'$.source_kind') AS source_kind,
		       json_extract(value,'$.source_id') AS source_id
		FROM json_each(json(?),'$.links')
	),
	matched_sources AS (
		SELECT gs.source_kind AS source_kind, gs.source_id AS source_id,
		       gs.source_updated_at AS source_updated_at, gs.source_sha256 AS source_sha256
		FROM guard_sources gs JOIN memories m ON m.userId=? AND m.id=gs.source_id
		WHERE gs.source_kind='memory' AND m.suppressed=0
			AND m.updated_at=gs.source_updated_at
			AND m.id=json_extract(gs.canonical,'$.id')
			AND m.text=json_extract(gs.canonical,'$.text')
			AND m.category=json_extract(gs.canonical,'$.category')
			AND m.layer=json_extract(gs.canonical,'$.layer')
			AND m.source_type=json_extract(gs.canonical,'$.source_type')
			AND (m.last_verified IS json_extract(gs.canonical,'$.last_verified'))
			AND m.confidence=json_extract(gs.canonical,'$.confidence')
			AND m.salience=json_extract(gs.canonical,'$.salience')
			AND m.pinned=json_extract(gs.canonical,'$.pinned')
			AND m.suppressed=json_extract(gs.canonical,'$.suppressed')
		UNION ALL
		SELECT gs.source_kind, gs.source_id, gs.source_updated_at, gs.source_sha256
		FROM guard_sources gs JOIN profile_facts pf ON pf.userId=? AND pf.id=gs.source_id
		WHERE gs.source_kind='profile_fact' AND pf.status='active'
			AND pf.updated_at=gs.source_updated_at
			AND pf.id=json_extract(gs.canonical,'$.id')
			AND pf.section=json_extract(gs.canonical,'$.section')
			AND pf.field=json_extract(gs.canonical,'$.field')
			AND (pf.value IS json_extract(gs.canonical,'$.value'))
			AND pf.confidence=json_extract(gs.canonical,'$.confidence')
			AND pf.source_type=json_extract(gs.canonical,'$.source_type')
			AND (pf.source_id IS json_extract(gs.canonical,'$.source_id'))
			AND pf.verified_at=json_extract(gs.canonical,'$.verified_at')
		UNION ALL
		SELECT gs.source_kind, gs.source_id, gs.source_updated_at, gs.source_sha256
		FROM guard_sources gs JOIN behavioral_observations b ON b.userId=? AND b.id=gs.source_id
		WHERE gs.source_kind='behavioral_observation' AND b.status='active'
			AND b.created_at=gs.source_updated_at
			AND b.id=json_extract(gs.canonical,'$.id')
			AND b.observation_type=json_extract(gs.canonical,'$.observation_type')
			AND b.content=json_extract(gs.canonical,'$.content')
			AND (b.context IS json_extract(gs.canonical,'$.context'))
			AND b.source_type=json_extract(gs.canonical,'$.source_type')
			AND b.confidence=json_extract(gs.canonical,'$.confidence')
			AND (b.verified_at IS json_extract(gs.canonical,'$.verified_at'))
		UNION ALL
		SELECT gs.source_kind, gs.source_id, gs.source_updated_at, gs.source_sha256
		FROM guard_sources gs JOIN personality_feedback pfb ON pfb.userId=? AND pfb.id=gs.source_id
		WHERE gs.source_kind='personality_feedback'
			AND pfb.created_at=gs.source_updated_at
			AND pfb.id=json_extract(gs.canonical,'$.id')
			AND (pfb.persona IS json_extract(gs.canonical,'$.persona'))
			AND (pfb.tone IS json_extract(gs.canonical,'$.tone'))
			AND (pfb.mode IS json_extract(gs.canonical,'$.mode'))
			AND (pfb.situation IS json_extract(gs.canonical,'$.situation'))
			AND (pfb.outcome IS json_extract(gs.canonical,'$.outcome'))
			AND (pfb.feedback_score IS json_extract(gs.canonical,'$.feedback_score'))
	)
SELECT ?, ?, gl.claim_id, gl.source_kind, gl.source_id,
       ms.source_updated_at, ms.source_sha256, 'supporting'
FROM guard_links gl
JOIN matched_sources ms ON ms.source_kind=gl.source_kind AND ms.source_id=gl.source_id`;

export function createD1ArtifactStore(
	env: Env,
	deps: Partial<ArtifactStoreDependencies> = {},
): ArtifactStore {
	const now = deps.now ?? (() => new Date().toISOString());
	const id = deps.id ?? (() => crypto.randomUUID());

	async function fetchRowById(
		userId: string,
		artifactId: string,
	): Promise<ArtifactRow | null> {
		return env.DB.prepare(
			`SELECT ${ARTIFACT_COLUMNS} FROM derived_artifacts WHERE userId=? AND id=?`,
		)
			.bind(userId, artifactId)
			.first<ArtifactRow>();
	}

	async function fetchActiveRow(
		userId: string,
		kind: ArtifactKind,
	): Promise<ArtifactRow | null> {
		return env.DB.prepare(
			`SELECT ${ARTIFACT_COLUMNS} FROM derived_artifacts
			 WHERE userId=? AND kind=? AND status IN ('published','stale')
			 ORDER BY version DESC LIMIT 1`,
		)
			.bind(userId, kind)
			.first<ArtifactRow>();
	}

	async function getEvidenceGeneration(
		userId: string,
		kind: ArtifactKind,
	): Promise<number> {
		const row = await env.DB.prepare(
			`SELECT COALESCE(generation,0) AS generation
			 FROM derived_artifact_evidence_state WHERE userId=? AND kind=?`,
		)
			.bind(userId, kind)
			.first<{ generation: number }>();
		return row?.generation ?? 0;
	}

	function buildGuardBundleFromDraft(
		draft: ArtifactDraft,
		liveCanonical: Map<
			string,
			{ canonical: Record<string, string | number | null>; updatedAt: string }
		>,
	): { bundle: SourceGuardBundle; linkCount: number } {
		const evidenceByKey = new Map(
			draft.evidence.map((source) => [`${source.kind}:${source.id}`, source]),
		);
		const links: SourceGuardBundle["links"] = [];
		const linkKeys = new Set<string>();
		const citedKeys = new Set<string>();
		for (const claim of draft.claims) {
			for (const citation of claim.citations) {
				const key = `${citation.source_kind}:${citation.source_id}`;
				const linkKey = `${claim.id}:${key}`;
				if (linkKeys.has(linkKey)) {
					throw new Error("Duplicate artifact source link");
				}
				linkKeys.add(linkKey);
				citedKeys.add(key);
				links.push({
					claim_id: claim.id,
					source_kind: citation.source_kind,
					source_id: citation.source_id,
				});
			}
		}
		if (links.length < 1 || links.length > MAX_ARTIFACT_SOURCE_LINKS) {
			throw new Error("Artifact source link count out of bounds");
		}
		if (citedKeys.size < 1 || citedKeys.size > MAX_ARTIFACT_UNIQUE_SOURCES) {
			throw new Error("Artifact unique source count out of bounds");
		}
		const sources: SourceGuardBundle["sources"] = [];
		for (const key of citedKeys) {
			const evidence = evidenceByKey.get(key);
			const live = liveCanonical.get(key);
			if (!evidence || !live) {
				throw new Error(`Missing current source for ${key}`);
			}
			sources.push({
				source_kind: evidence.kind,
				source_id: evidence.id,
				source_updated_at: live.updatedAt,
				source_sha256: evidence.sourceSha256,
				canonical: live.canonical,
			});
		}
		return { bundle: { v: 1, sources, links }, linkCount: links.length };
	}

	async function preflightSources(
		userId: string,
		citedKeys: Array<{ source_kind: ArtifactSourceKind; source_id: string }>,
		expected: Map<string, { sha: string; updatedAt: string }>,
	): Promise<
		Map<string, { canonical: Record<string, string | number | null>; updatedAt: string }>
	> {
		const requestJson = JSON.stringify(citedKeys);
		if (byteLength(requestJson) > MAX_SOURCE_REQUEST_JSON_BYTES) {
			throw new Error("Artifact source request is oversized");
		}
		const rows = await env.DB.prepare(PREFLIGHT_SQL)
			.bind(requestJson, userId, userId, userId, userId)
			.all<{
				source_kind: ArtifactSourceKind;
				source_id: string;
				canonical_json: string | null;
			}>();
		if (rows.results.length !== citedKeys.length) {
			throw new Error("Artifact source preflight cardinality mismatch");
		}
		const updatedField: Record<ArtifactSourceKind, string> = {
			memory: "updated_at",
			profile_fact: "updated_at",
			behavioral_observation: "created_at",
			personality_feedback: "created_at",
		};
		const result = new Map<
			string,
			{ canonical: Record<string, string | number | null>; updatedAt: string }
		>();
		for (const row of rows.results) {
			const key = `${row.source_kind}:${row.source_id}`;
			if (result.has(key)) {
				throw new Error("Duplicate artifact source in preflight");
			}
			if (!row.canonical_json) {
				throw new Error(`Absent or inactive source ${key}`);
			}
			const canonical = JSON.parse(row.canonical_json) as Record<
				string,
				string | number | null
			>;
			const recomputed = await sha256Hex(canonicalJson(canonical));
			const want = expected.get(key);
			const updatedAt = String(canonical[updatedField[row.source_kind]]);
			if (!want || recomputed !== want.sha || updatedAt !== want.updatedAt) {
				throw new Error(`Stale or mismatched source ${key}`);
			}
			result.set(key, { canonical, updatedAt });
		}
		return result;
	}

	async function assertValidatedDraft(draft: ArtifactDraft): Promise<void> {
		const claims = artifactClaimsSchema.parse(draft.claims);
		const recomputed = await artifactContentSha256(claims, draft.renderedText);
		if (recomputed !== draft.contentSha256) {
			throw new Error("Draft content hash does not match its claims");
		}
	}

	async function insertCandidateBatch(
		userId: string,
		draft: ArtifactDraft,
		evidenceGeneration: number,
		artifactId: string,
	): Promise<void> {
		const citedKeys = new Map<
			string,
			{ source_kind: ArtifactSourceKind; source_id: string }
		>();
		const expected = new Map<string, { sha: string; updatedAt: string }>();
		for (const claim of draft.claims) {
			for (const citation of claim.citations) {
				const key = `${citation.source_kind}:${citation.source_id}`;
				citedKeys.set(key, {
					source_kind: citation.source_kind,
					source_id: citation.source_id,
				});
				const evidence = draft.evidence.find(
					(item) => `${item.kind}:${item.id}` === key,
				);
				if (!evidence) throw new Error(`Uncited source referenced: ${key}`);
				expected.set(key, {
					sha: evidence.sourceSha256,
					updatedAt: evidence.updatedAt,
				});
			}
		}
		const live = await preflightSources(
			userId,
			[...citedKeys.values()],
			expected,
		);
		const { bundle, linkCount } = buildGuardBundleFromDraft(draft, live);
		const bundleJson = JSON.stringify(bundle);
		if (byteLength(bundleJson) > MAX_SOURCE_GUARD_JSON_BYTES) {
			throw new Error("Artifact source guard bundle is oversized");
		}
		const timestamp = now();
		const candidateInsert = env.DB.prepare(
			`INSERT INTO derived_artifacts (
				id,userId,kind,version,status,validation_state,content_json,rendered_text,
				source_watermark,evidence_generation,eligible_source_count,
				selected_source_count,source_truncated,content_sha256,model,prompt_version,
				validation_json,created_at
			)
			SELECT ?,?,?,COALESCE(MAX(version),0)+1,'candidate','validated',?,?,?,?,?,?,?,?,?,?,?,?
			FROM derived_artifacts versions
			WHERE versions.userId=? AND versions.kind=?
			HAVING ?=COALESCE((SELECT generation FROM derived_artifact_evidence_state current
				WHERE current.userId=? AND current.kind=?),0)`,
		).bind(
			artifactId,
			userId,
			draft.kind,
			JSON.stringify({ claims: draft.claims }),
			draft.renderedText,
			draft.sourceWatermark,
			evidenceGeneration,
			draft.eligibleSourceCount,
			draft.selectedSourceCount,
			draft.sourceTruncated ? 1 : 0,
			draft.contentSha256,
			draft.model,
			draft.promptVersion,
			JSON.stringify(draft.validation),
			timestamp,
			userId,
			draft.kind,
			evidenceGeneration,
			userId,
			draft.kind,
		);
		const linkInsert = env.DB.prepare(BULK_LINK_INSERT_SQL).bind(
			bundleJson,
			bundleJson,
			userId,
			userId,
			userId,
			userId,
			artifactId,
			userId,
		);
		const eventInsert = env.DB.prepare(
			`INSERT INTO derived_artifact_events
				(id,userId,artifact_id,kind,event_type,reason_code,actor,source_watermark,metadata_json,created_at)
			 SELECT ?,?,?,(
				SELECT a.kind FROM derived_artifacts a
				WHERE a.userId=? AND a.id=? AND a.status='candidate'
				  AND (SELECT COUNT(*) FROM derived_artifact_sources s
				       WHERE s.userId=? AND s.artifact_id=?)=?
				  AND (SELECT COUNT(*) FROM json_each(json(?),'$.links'))=?
			 ),'generated',NULL,'system',?,'{}',?`,
		).bind(
			id(),
			userId,
			artifactId,
			userId,
			artifactId,
			userId,
			artifactId,
			linkCount,
			bundleJson,
			linkCount,
			draft.sourceWatermark,
			timestamp,
		);
		await env.DB.batch([candidateInsert, linkInsert, eventInsert]);
	}

	async function cacheArtifactIfStillReadable(
		userId: string,
		kind: ArtifactKind,
		artifactId: string,
		expectedSha: string,
	): Promise<void> {
		const before = await fetchRowById(userId, artifactId);
		if (
			!before ||
			!(before.status === "published" || before.status === "stale") ||
			before.content_sha256 !== expectedSha ||
			!before.rendered_text
		) {
			return;
		}
		const envelope: ArtifactCacheEnvelope = {
			artifactId,
			contentSha256: expectedSha,
			claims: rowToArtifact(before).claims,
			renderedText: before.rendered_text,
		};
		try {
			await putArtifactCache(userId, kind, envelope, env);
		} catch {
			return;
		}
		const after = await fetchRowById(userId, artifactId);
		const stillReadable =
			after &&
			(after.status === "published" || after.status === "stale") &&
			after.content_sha256 === expectedSha;
		if (stillReadable) return;
		try {
			await deleteArtifactCache(userId, kind, artifactId, env);
		} catch {
			const timestamp = now();
			await env.DB.prepare(
				`INSERT INTO artifact_cache_purge_queue
					(userId,kind,artifact_id,operation_id,attempt_count,next_attempt_at,
					 last_error_code,created_at,updated_at)
				 VALUES (?,?,?,?,0,?,'kv_delete_failed',?,?)
				 ON CONFLICT(userId,artifact_id) DO UPDATE SET
					operation_id=excluded.operation_id,
					attempt_count=0,
					next_attempt_at=excluded.next_attempt_at,
					last_error_code=excluded.last_error_code,
					updated_at=excluded.updated_at`,
			)
				.bind(userId, kind, artifactId, id(), timestamp, timestamp, timestamp)
				.run();
		}
	}

	const store: ArtifactStore = {
		getEvidenceGeneration,

		async getArtifactById(userId, artifactId) {
			const row = await fetchRowById(userId, artifactId);
			if (!row || row.status === "tombstoned") return null;
			return rowToArtifact(row);
		},

		async getArtifactDetail(userId, artifactId) {
			const row = await fetchRowById(userId, artifactId);
			if (!row || row.status === "tombstoned") return null;
			const artifact = rowToArtifact(row);
			const sources = await env.DB.prepare(
				`SELECT artifact_id,userId,claim_id,source_kind,source_id,
				        source_updated_at,source_sha256,citation_role
				 FROM derived_artifact_sources WHERE userId=? AND artifact_id=?
				 ORDER BY claim_id,source_kind,source_id`,
			)
				.bind(userId, artifactId)
				.all<DerivedArtifactSource>();
			const events = await env.DB.prepare(
				`SELECT id,userId,artifact_id,kind,event_type,reason_code,actor,
				        source_watermark,metadata_json,created_at
				 FROM derived_artifact_events WHERE userId=? AND artifact_id=?
				 ORDER BY created_at ASC,id ASC`,
			)
				.bind(userId, artifactId)
				.all<
					Omit<DerivedArtifactEvent, "metadata"> & { metadata_json: string }
				>();
			return {
				artifact,
				sources: sources.results,
				events: events.results.map((event) => ({
					id: event.id,
					userId: event.userId,
					artifact_id: event.artifact_id,
					kind: event.kind,
					event_type: event.event_type,
					reason_code: event.reason_code,
					actor: event.actor,
					source_watermark: event.source_watermark,
					metadata: JSON.parse(event.metadata_json ?? "{}"),
					created_at: event.created_at,
				})),
			};
		},

		async getActiveArtifact(userId, kind) {
			const row = await fetchActiveRow(userId, kind);
			return row ? rowToArtifact(row) : null;
		},

		async listArtifacts(userId, filters = {}) {
			const limit = Math.min(Math.max(filters.limit ?? 20, 1), 50);
			const clauses = ["userId=?", "status != 'tombstoned'"];
			const binds: unknown[] = [userId];
			if (filters.kind) {
				clauses.push("kind=?");
				binds.push(filters.kind);
			}
			if (filters.status) {
				clauses.push("status=?");
				binds.push(filters.status);
			}
			if (filters.cursor) {
				clauses.push("(created_at < ? OR (created_at = ? AND id < ?))");
				binds.push(filters.cursor.createdAt, filters.cursor.createdAt, filters.cursor.id);
			}
			const rows = await env.DB.prepare(
				`SELECT ${ARTIFACT_COLUMNS} FROM derived_artifacts
				 WHERE ${clauses.join(" AND ")}
				 ORDER BY created_at DESC, id DESC LIMIT ?`,
			)
				.bind(...binds, limit + 1)
				.all<ArtifactRow>();
			const page = rows.results.slice(0, limit);
			const last = page[page.length - 1];
			const nextCursor =
				rows.results.length > limit && last
					? { createdAt: last.created_at, id: last.id }
					: null;
			return { items: page.map(rowToArtifact), nextCursor };
		},

		async createArtifactCandidate(userId, draft, evidenceGeneration) {
			await assertValidatedDraft(draft);
			const existing = await env.DB.prepare(
				`SELECT ${ARTIFACT_COLUMNS} FROM derived_artifacts
				 WHERE userId=? AND kind=? AND status='candidate'
				   AND source_watermark=? AND evidence_generation=?`,
			)
				.bind(userId, draft.kind, draft.sourceWatermark, evidenceGeneration)
				.first<ArtifactRow>();
			if (existing) {
				const current = await getEvidenceGeneration(userId, draft.kind);
				if (current === evidenceGeneration) return rowToArtifact(existing);
			}
			const artifactId = id();
			try {
				await insertCandidateBatch(userId, draft, evidenceGeneration, artifactId);
			} catch (error) {
				const winner = await env.DB.prepare(
					`SELECT ${ARTIFACT_COLUMNS} FROM derived_artifacts
					 WHERE userId=? AND kind=? AND status='candidate'
					   AND source_watermark=? AND evidence_generation=?`,
				)
					.bind(userId, draft.kind, draft.sourceWatermark, evidenceGeneration)
					.first<ArtifactRow>();
				if (winner) {
					const current = await getEvidenceGeneration(userId, draft.kind);
					if (current === evidenceGeneration) return rowToArtifact(winner);
				}
				throw error;
			}
			const created = await fetchRowById(userId, artifactId);
			if (!created) throw new Error("Candidate creation did not persist");
			return rowToArtifact(created);
		},

		async publishArtifact(userId, artifactId, actor) {
			const candidate = await fetchRowById(userId, artifactId);
			if (!candidate || candidate.status !== "candidate") {
				throw new Error("Artifact is not a publishable candidate");
			}
			const kind = candidate.kind;
			const active = await fetchActiveRow(userId, kind);
			const timestamp = now();
			const statements: D1PreparedStatement[] = [];
			if (active) {
				statements.push(
					env.DB.prepare(
						`UPDATE derived_artifacts SET status='superseded'
						 WHERE userId=? AND id=? AND kind=? AND status IN ('published','stale')
						   AND EXISTS (SELECT 1 FROM derived_artifacts candidate
							WHERE candidate.userId=? AND candidate.id=? AND candidate.kind=?
							  AND candidate.status='candidate' AND candidate.validation_state='validated'
							  AND candidate.source_watermark=?
							  AND candidate.evidence_generation=COALESCE((SELECT generation
								FROM derived_artifact_evidence_state current
								WHERE current.userId=candidate.userId AND current.kind=candidate.kind),0))`,
					).bind(
						userId,
						active.id,
						kind,
						userId,
						artifactId,
						kind,
						candidate.source_watermark,
					),
				);
				statements.push(
					env.DB.prepare(
						`INSERT INTO derived_artifact_events
							(id,userId,artifact_id,kind,event_type,reason_code,actor,source_watermark,metadata_json,created_at)
						 SELECT ?,?,?,kind,'superseded','republished',?,source_watermark,'{}',?
						 FROM derived_artifacts WHERE userId=? AND id=? AND status='superseded'`,
					).bind(id(), userId, active.id, actor, timestamp, userId, active.id),
				);
			}
			statements.push(
				env.DB.prepare(
					`UPDATE derived_artifacts
					 SET status='published',supersedes_id=?,published_at=?,reviewed_at=?,reviewed_by=?
					 WHERE userId=? AND id=? AND kind=? AND status='candidate'
					   AND validation_state='validated' AND source_watermark=?
					   AND evidence_generation=COALESCE((SELECT generation
						FROM derived_artifact_evidence_state current
						WHERE current.userId=derived_artifacts.userId AND current.kind=derived_artifacts.kind),0)
					   AND NOT EXISTS (SELECT 1 FROM derived_artifacts active
						WHERE active.userId=? AND active.kind=? AND active.status IN ('published','stale'))`,
				).bind(
					active?.id ?? null,
					timestamp,
					timestamp,
					actor,
					userId,
					artifactId,
					kind,
					candidate.source_watermark,
					userId,
					kind,
				),
			);
			statements.push(
				env.DB.prepare(
					`INSERT INTO derived_artifact_legacy_state
						(userId,kind,state,operation_id,legacy_sha256,imported_at,retired_at,updated_at)
					 SELECT c.userId,c.kind,'retired',?,NULL,NULL,?,?
					 FROM derived_artifacts c WHERE c.userId=? AND c.id=? AND c.status='published'
					 ON CONFLICT(userId,kind) DO UPDATE SET
						state='retired',operation_id=excluded.operation_id,legacy_sha256=NULL,
						retired_at=excluded.retired_at,updated_at=excluded.updated_at`,
				).bind(id(), timestamp, timestamp, userId, artifactId),
			);
			if (kind === "living_summary") {
				statements.push(
					env.DB.prepare(
						`DELETE FROM derived_artifact_rebuild_state
						 WHERE userId=? AND kind='living_summary'
						   AND EXISTS (SELECT 1 FROM derived_artifacts
							WHERE userId=? AND id=? AND status='published')`,
					).bind(userId, userId, artifactId),
				);
			}
			statements.push(
				env.DB.prepare(
					`INSERT INTO derived_artifact_events
						(id,userId,artifact_id,kind,event_type,reason_code,actor,source_watermark,metadata_json,created_at)
					 SELECT ?,?,?,(SELECT a.kind FROM derived_artifacts a
						WHERE a.userId=? AND a.id=? AND a.status='published'),
						'published',NULL,?,?,'{}',?`,
				).bind(
					id(),
					userId,
					artifactId,
					userId,
					artifactId,
					actor,
					candidate.source_watermark,
					timestamp,
				),
			);
			await env.DB.batch(statements);
			const published = await fetchRowById(userId, artifactId);
			if (!published || published.status !== "published") {
				throw new Error("Publication did not take effect");
			}
			if (published.content_sha256) {
				await cacheArtifactIfStillReadable(
					userId,
					kind,
					artifactId,
					published.content_sha256,
				);
			}
			return rowToArtifact(published);
		},

		async markArtifactStale(userId, kind, reasonCode, actor) {
			const active = await fetchActiveRow(userId, kind);
			if (!active || active.status !== "published") return null;
			const timestamp = now();
			await env.DB.batch([
				env.DB.prepare(
					`UPDATE derived_artifacts SET status='stale'
					 WHERE userId=? AND id=? AND status='published'`,
				).bind(userId, active.id),
				env.DB.prepare(
					`INSERT INTO derived_artifact_events
						(id,userId,artifact_id,kind,event_type,reason_code,actor,source_watermark,metadata_json,created_at)
					 SELECT ?,?,?,kind,'stale',?,?,source_watermark,'{}',?
					 FROM derived_artifacts WHERE userId=? AND id=? AND status='stale'`,
				).bind(id(), userId, active.id, reasonCode, actor, timestamp, userId, active.id),
			]);
			const updated = await fetchRowById(userId, active.id);
			return updated ? rowToArtifact(updated) : null;
		},

		async rejectArtifact(userId, artifactId, reason, actor) {
			const trimmed = reason.trim();
			if (trimmed.length < 1 || trimmed.length > 500) {
				throw new Error("Rejection reason must be 1-500 characters");
			}
			if (containsHardSecret(trimmed)) {
				throw new Error("Rejection reason must not contain secrets");
			}
			const candidate = await fetchRowById(userId, artifactId);
			if (!candidate || candidate.status !== "candidate") {
				throw new Error("Artifact is not a rejectable candidate");
			}
			const timestamp = now();
			await env.DB.batch([
				env.DB.prepare(
					`UPDATE derived_artifacts SET status='rejected',reviewed_at=?,reviewed_by=?
					 WHERE userId=? AND id=? AND status='candidate'`,
				).bind(timestamp, actor, userId, artifactId),
				env.DB.prepare(
					`INSERT INTO derived_artifact_events
						(id,userId,artifact_id,kind,event_type,reason_code,actor,source_watermark,metadata_json,created_at)
					 SELECT ?,?,?,kind,'rejected','reviewer_rejected',?,source_watermark,?,?
					 FROM derived_artifacts WHERE userId=? AND id=? AND status='rejected'`,
				).bind(
					id(),
					userId,
					artifactId,
					actor,
					JSON.stringify({ reason: trimmed }),
					timestamp,
					userId,
					artifactId,
				),
			]);
			const rejected = await fetchRowById(userId, artifactId);
			if (!rejected || rejected.status !== "rejected") {
				throw new Error("Rejection did not take effect");
			}
			return rowToArtifact(rejected);
		},

		async restoreHistoricalArtifact(
			userId,
			historicalArtifactId,
			draft,
			evidenceGeneration,
			reason,
			actor,
		) {
			const trimmed = reason.trim();
			if (trimmed.length < 1 || trimmed.length > 500) {
				throw new Error("Restoration reason must be 1-500 characters");
			}
			if (containsHardSecret(trimmed)) {
				throw new Error("Restoration reason must not contain secrets");
			}
			const historical = await fetchRowById(userId, historicalArtifactId);
			if (
				!historical ||
				!["published", "stale", "superseded"].includes(historical.status) ||
				!historical.published_at
			) {
				throw new Error("Historical artifact is not restorable");
			}
			const historicalArtifact = rowToArtifact(historical);
			const historicalHash = await artifactContentSha256(
				historicalArtifact.claims,
				historical.rendered_text ?? "",
			);
			if (historicalHash !== historical.content_sha256) {
				throw new Error("Historical artifact hash is corrupt");
			}
			await assertValidatedDraft(draft);
			const expectedValidation = {
				...historicalArtifact.validation,
				restored_from: historical.id,
				restoration_reason: trimmed,
			};
			const cloneMatches =
				draft.kind === historicalArtifact.kind &&
				draft.contentSha256 === historical.content_sha256 &&
				draft.renderedText === (historical.rendered_text ?? "") &&
				draft.sourceWatermark === historical.source_watermark &&
				draft.model === historical.model &&
				draft.promptVersion === historical.prompt_version &&
				draft.eligibleSourceCount === historical.eligible_source_count &&
				draft.selectedSourceCount === historical.selected_source_count &&
				draft.sourceTruncated === (historical.source_truncated !== 0) &&
				canonicalJson(draft.claims) === canonicalJson(historicalArtifact.claims) &&
				canonicalJson(draft.validation) === canonicalJson(expectedValidation);
			if (!cloneMatches) {
				throw new Error("Restoration draft is not a faithful historical clone");
			}
			const active = await fetchActiveRow(userId, draft.kind);
			const newId = id();
			const timestamp = now();
			const statements: D1PreparedStatement[] = [];
			if (active) {
				statements.push(
					env.DB.prepare(
						`UPDATE derived_artifacts SET status='superseded'
						 WHERE userId=? AND id=? AND kind=? AND status IN ('published','stale')`,
					).bind(userId, active.id, draft.kind),
				);
				statements.push(
					env.DB.prepare(
						`INSERT INTO derived_artifact_events
							(id,userId,artifact_id,kind,event_type,reason_code,actor,source_watermark,metadata_json,created_at)
						 SELECT ?,?,?,kind,'superseded','restored_over',?,source_watermark,'{}',?
						 FROM derived_artifacts WHERE userId=? AND id=? AND status='superseded'`,
					).bind(id(), userId, active.id, actor, timestamp, userId, active.id),
				);
			}
			statements.push(
				env.DB.prepare(
					`INSERT INTO derived_artifacts (
						id,userId,kind,version,status,validation_state,content_json,rendered_text,
						source_watermark,evidence_generation,eligible_source_count,
						selected_source_count,source_truncated,content_sha256,model,prompt_version,
						validation_json,supersedes_id,created_at,published_at,reviewed_at,reviewed_by
					)
					SELECT ?,?,?,COALESCE(MAX(version),0)+1,'published','validated',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
					FROM derived_artifacts versions WHERE versions.userId=? AND versions.kind=?
					  AND NOT EXISTS (SELECT 1 FROM derived_artifacts active
						WHERE active.userId=? AND active.kind=? AND active.status IN ('published','stale'))`,
				).bind(
					newId,
					userId,
					draft.kind,
					JSON.stringify({ claims: draft.claims }),
					draft.renderedText,
					draft.sourceWatermark,
					evidenceGeneration,
					draft.eligibleSourceCount,
					draft.selectedSourceCount,
					draft.sourceTruncated ? 1 : 0,
					draft.contentSha256,
					draft.model,
					draft.promptVersion,
					JSON.stringify(expectedValidation),
					active?.id ?? null,
					timestamp,
					timestamp,
					timestamp,
					actor,
					userId,
					draft.kind,
					userId,
					draft.kind,
				),
			);
			const restorationBundleJson = await buildRestorationBundleJson(userId, draft);
			statements.push(
				env.DB.prepare(BULK_LINK_INSERT_SQL).bind(
					restorationBundleJson,
					restorationBundleJson,
					userId,
					userId,
					userId,
					userId,
					newId,
					userId,
				),
			);
			statements.push(
				env.DB.prepare(
					`INSERT INTO derived_artifact_events
						(id,userId,artifact_id,kind,event_type,reason_code,actor,source_watermark,metadata_json,created_at)
					 SELECT ?,?,?,(SELECT a.kind FROM derived_artifacts a
						WHERE a.userId=? AND a.id=? AND a.status='published'),
						'restored',NULL,?,?,?,?`,
				).bind(
					id(),
					userId,
					newId,
					userId,
					newId,
					actor,
					draft.sourceWatermark,
					JSON.stringify({ restored_from: historical.id, reason: trimmed }),
					timestamp,
				),
			);
			if (draft.kind === "living_summary") {
				statements.push(
					env.DB.prepare(
						`DELETE FROM derived_artifact_rebuild_state
						 WHERE userId=? AND kind='living_summary'
						   AND EXISTS (SELECT 1 FROM derived_artifacts
							WHERE userId=? AND id=? AND status='published')`,
					).bind(userId, userId, newId),
				);
			}
			statements.push(
				env.DB.prepare(
					`INSERT INTO derived_artifact_events
						(id,userId,artifact_id,kind,event_type,reason_code,actor,source_watermark,metadata_json,created_at)
					 SELECT ?,?,?,(SELECT a.kind FROM derived_artifacts a
						WHERE a.userId=? AND a.id=? AND a.status='published'),
						'published',NULL,?,?,'{}',?`,
				).bind(id(), userId, newId, userId, newId, actor, draft.sourceWatermark, timestamp),
			);
			await env.DB.batch(statements);
			const restored = await fetchRowById(userId, newId);
			if (!restored || restored.status !== "published") {
				throw new Error("Restoration did not take effect");
			}
			if (restored.content_sha256) {
				await cacheArtifactIfStillReadable(
					userId,
					draft.kind,
					newId,
					restored.content_sha256,
				);
			}
			return rowToArtifact(restored);
		},

		async recordArtifactFailure(userId, kind, reasonCode, sourceWatermark) {
			if (!ARTIFACT_FAILURE_CODES.includes(reasonCode)) {
				throw new Error(`Unknown artifact failure code: ${reasonCode}`);
			}
			await env.DB.prepare(
				`INSERT INTO derived_artifact_events
					(id,userId,artifact_id,kind,event_type,reason_code,actor,source_watermark,metadata_json,created_at)
				 VALUES (?,?,NULL,?,'generation_failed',?,'system',?,'{}',?)`,
			)
				.bind(id(), userId, kind, reasonCode, sourceWatermark, now())
				.run();
		},

		async getLegacyImportState(userId, kind) {
			const row = await env.DB.prepare(
				`SELECT state FROM derived_artifact_legacy_state WHERE userId=? AND kind=?`,
			)
				.bind(userId, kind)
				.first<{ state: "imported" | "retired" }>();
			return row?.state ?? null;
		},

		async importLegacyArtifact(userId, kind, text) {
			const existingActive = await fetchActiveRow(userId, kind);
			if (existingActive) return rowToArtifact(existingActive);
			const contentSha = await artifactContentSha256([], text);
			const evidenceGeneration = await getEvidenceGeneration(userId, kind);
			const operationId = id();
			const newId = id();
			const timestamp = now();
			await env.DB.batch([
				env.DB.prepare(
					`INSERT INTO derived_artifact_legacy_state
						(userId,kind,state,operation_id,legacy_sha256,imported_at,retired_at,updated_at)
					 VALUES (?,?,'imported',?,?,?,NULL,?)
					 ON CONFLICT(userId,kind) DO NOTHING`,
				).bind(userId, kind, operationId, contentSha, timestamp, timestamp),
				env.DB.prepare(
					`INSERT INTO derived_artifacts (
						id,userId,kind,version,status,validation_state,content_json,rendered_text,
						source_watermark,evidence_generation,eligible_source_count,
						selected_source_count,source_truncated,content_sha256,model,prompt_version,
						validation_json,created_at,published_at
					)
					SELECT ?,?,?,COALESCE((SELECT MAX(version) FROM derived_artifacts v
						WHERE v.userId=? AND v.kind=?),0)+1,'stale','legacy_unverified',
						?,?,NULL,?,0,0,0,?,NULL,'legacy-import','{}',?,?
					FROM derived_artifact_legacy_state s
					WHERE s.userId=? AND s.kind=? AND s.operation_id=? AND s.state='imported'`,
				).bind(
					newId,
					userId,
					kind,
					userId,
					kind,
					JSON.stringify({ claims: [] }),
					text,
					evidenceGeneration,
					contentSha,
					timestamp,
					timestamp,
					userId,
					kind,
					operationId,
				),
				env.DB.prepare(
					`INSERT INTO derived_artifact_events
						(id,userId,artifact_id,kind,event_type,reason_code,actor,source_watermark,metadata_json,created_at)
					 SELECT ?,?,?,kind,'legacy_imported',NULL,'system',NULL,'{}',?
					 FROM derived_artifacts WHERE userId=? AND id=?`,
				).bind(id(), userId, newId, timestamp, userId, newId),
			]);
			const active = await fetchActiveRow(userId, kind);
			return active ? rowToArtifact(active) : null;
		},

		async readActiveArtifact(userId, kind) {
			const activeRow = await fetchActiveRow(userId, kind);
			if (!activeRow) return null;
			const artifact = rowToArtifact(activeRow);
			if (!activeRow.content_sha256) return artifact;
			const cached = await getArtifactCache(
				userId,
				kind,
				activeRow.id,
				activeRow.content_sha256,
				env,
			);
			if (!cached) {
				await cacheArtifactIfStillReadable(
					userId,
					kind,
					activeRow.id,
					activeRow.content_sha256,
				);
			}
			return artifact;
		},
	};

	async function buildRestorationBundleJson(
		userId: string,
		draft: ArtifactDraft,
	): Promise<string> {
		const citedKeys = new Map<
			string,
			{ source_kind: ArtifactSourceKind; source_id: string }
		>();
		const expected = new Map<string, { sha: string; updatedAt: string }>();
		for (const claim of draft.claims) {
			for (const citation of claim.citations) {
				const key = `${citation.source_kind}:${citation.source_id}`;
				citedKeys.set(key, {
					source_kind: citation.source_kind,
					source_id: citation.source_id,
				});
				const evidence = draft.evidence.find(
					(item) => `${item.kind}:${item.id}` === key,
				);
				if (!evidence) throw new Error(`Uncited source referenced: ${key}`);
				expected.set(key, {
					sha: evidence.sourceSha256,
					updatedAt: evidence.updatedAt,
				});
			}
		}
		const live = await preflightSources(userId, [...citedKeys.values()], expected);
		const { bundle } = buildGuardBundleFromDraft(draft, live);
		const bundleJson = JSON.stringify(bundle);
		if (byteLength(bundleJson) > MAX_SOURCE_GUARD_JSON_BYTES) {
			throw new Error("Artifact source guard bundle is oversized");
		}
		return bundleJson;
	}

	return store;
}
