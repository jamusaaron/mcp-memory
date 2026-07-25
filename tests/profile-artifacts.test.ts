import assert from "node:assert/strict";
import test from "node:test";

import {
	createBehavioralArtifactHandlers,
	registerBehavioralTools,
} from "../src/tools/behavioral";
import {
	createPeopleArtifactHandlers,
	registerPeopleTools,
} from "../src/tools/people";
import { createSessionArtifactHandlers } from "../src/tools/session";
import type { ArtifactRebuildResult } from "../src/utils/artifact-service";
import type { ArtifactKind, DerivedArtifact } from "../src/types";

function structured<T extends Record<string, unknown>>(result: object): T {
	assert.ok("structuredContent" in result);
	return (result as { structuredContent: T }).structuredContent;
}

function artifact(overrides: Partial<DerivedArtifact> = {}): DerivedArtifact {
	return {
		id: "artifact-1",
		userId: "u1",
		kind: "living_summary",
		version: 1,
		status: "published",
		validation_state: "validated",
		claims: [],
		rendered_text: "Rendered",
		source_watermark: "watermark",
		evidence_generation: 1,
		eligible_source_count: 10,
		selected_source_count: 5,
		source_truncated: false,
		content_sha256: "sha",
		model: "@cf/test",
		prompt_version: "v1",
		validation: {},
		supersedes_id: null,
		created_at: "2026-07-24T00:00:00.000Z",
		published_at: "2026-07-24T00:00:00.000Z",
		reviewed_at: null,
		reviewed_by: null,
		...overrides,
	};
}

type HarnessOptions = {
	rebuild?: ArtifactRebuildResult;
	rebuildError?: Error;
	activeLiving?: DerivedArtifact | null;
	activeSelf?: DerivedArtifact | null;
	activeBehavior?: DerivedArtifact | null;
	selfCandidate?: DerivedArtifact;
	behaviorCandidate?: DerivedArtifact;
	legacyLivingSummary?: string | null;
	legacySelfProfile?: string | null;
};

/**
 * Mirrors the artifact service contract: only `published` or `stale` versions
 * resolve as active, so candidates, rejections and tombstones can never reach
 * a consumer through this harness.
 */
function consumerHarness(options: HarnessOptions = {}) {
	const resolved: Array<{ kind: ArtifactKind }> = [];
	const rebuilt: Array<{ kind: ArtifactKind }> = [];
	const confirmedFactWrites: Array<{
		userId: string;
		section: string;
		field: string;
		value: string;
	}> = [];
	const personProfileWrites: Array<{
		personId: string;
		userId: string;
		section: string;
		content: Record<string, unknown>;
	}> = [];
	const observationWrites: Array<{
		source_type: string;
		confidence: number;
		verified: boolean;
	}> = [];
	const observationRows: Array<Record<string, unknown>> = [];

	function active(kind: ArtifactKind): DerivedArtifact | null {
		const candidate =
			kind === "living_summary"
				? (options.activeLiving ?? null)
				: kind === "self_profile"
					? (options.activeSelf ?? null)
					: (options.activeBehavior ?? null);
		if (!candidate) return null;
		return candidate.status === "published" || candidate.status === "stale"
			? candidate
			: null;
	}

	const deps = {
		legacySelfBackfillCalls: 0,
		resolved,
		rebuilt,
		confirmedFactWrites,
		personProfileWrites,
		observationWrites,
		observationRows,
		legacyLivingSummary: options.legacyLivingSummary ?? null,
		legacySelfProfile: options.legacySelfProfile ?? null,
		async resolveActiveDerivedArtifact(
			_userId: string,
			kind: ArtifactKind,
			_env: Env,
		): Promise<DerivedArtifact | null> {
			resolved.push({ kind });
			return active(kind);
		},
		async rebuildDerivedArtifact(
			_userId: string,
			kind: ArtifactKind,
			_env: Env,
		): Promise<ArtifactRebuildResult> {
			rebuilt.push({ kind });
			if (options.rebuildError) throw options.rebuildError;
			if (kind === "living_summary") {
				return (
					options.rebuild ?? {
						artifact: artifact({ kind: "living_summary" }),
						reused: false,
						published: true,
					}
				);
			}
			const candidate =
				kind === "self_profile" ? options.selfCandidate : options.behaviorCandidate;
			return {
				artifact:
					candidate ??
					artifact({ id: `${kind}-candidate`, kind, status: "candidate" }),
				reused: false,
				published: false,
			};
		},
		async ensureLegacySelfProfileFacts(_userId: string, _env: Env) {
			deps.legacySelfBackfillCalls += 1;
			return { imported: 0, skipped: 0 };
		},
		async setConfirmedProfileFact(
			userId: string,
			input: { section: string; field: string; value: string },
			_env: Env,
		) {
			confirmedFactWrites.push({
				userId,
				section: input.section,
				field: input.field,
				value: input.value,
			});
			return null as never;
		},
		async upsertPersonProfile(
			personId: string,
			userId: string,
			section: string,
			content: Record<string, unknown>,
			_env: Env,
		) {
			personProfileWrites.push({ personId, userId, section, content });
		},
		async insertObservation(
			_userId: string,
			record: {
				source_type: string;
				confidence: number;
				verified: boolean;
				verified_at: string | null;
			},
			_env: Env,
		) {
			observationRows.push({ ...record });
			observationWrites.push({
				source_type: record.source_type,
				confidence: record.confidence,
				verified: record.verified,
			});
			return `observation-${observationWrites.length}`;
		},
	};
	return deps;
}

test("self and behavioral rebuilds return candidates but do not enter context", async () => {
	const deps = consumerHarness({
		activeSelf: artifact({
			id: "self-v1",
			kind: "self_profile",
			rendered_text: "Approved self",
		}),
		selfCandidate: artifact({
			id: "self-candidate",
			kind: "self_profile",
			status: "candidate",
			rendered_text: "Unapproved self",
		}),
		behaviorCandidate: artifact({
			id: "behavior-candidate",
			kind: "behavioral_profile",
			status: "candidate",
			rendered_text: "Unapproved behavior",
		}),
	});

	const selfResult = await createPeopleArtifactHandlers(
		"u1",
		{} as Env,
		deps,
	).rebuildSelfProfile({});
	const behaviorResult = await createBehavioralArtifactHandlers(
		"u1",
		{} as Env,
		deps,
	).behavioralModel({ rebuild: true });
	const brief = await createSessionArtifactHandlers(
		"u1",
		{} as Env,
		deps,
	).getSessionBrief({});

	assert.equal(structured<{ status: string }>(selfResult).status, "candidate");
	assert.equal(
		structured<{ status: string }>(behaviorResult).status,
		"candidate",
	);
	assert.equal(structured<{ artifact_id: string }>(selfResult).artifact_id, "self-candidate");
	assert.equal(structured<{ review_required: boolean }>(selfResult).review_required, true);
	assert.equal(
		structured<{ review_required: boolean }>(behaviorResult).review_required,
		true,
	);
	assert.match(brief.content[0].text, /Approved self/);
	assert.doesNotMatch(brief.content[0].text, /Unapproved/);
});

test("a rejected candidate leaves the approved behavioural profile in context", async () => {
	const deps = consumerHarness({
		activeBehavior: artifact({
			id: "behavior-approved",
			kind: "behavioral_profile",
			rendered_text: "Approved behavior",
		}),
		behaviorCandidate: artifact({
			id: "behavior-candidate",
			kind: "behavioral_profile",
			status: "rejected",
			rendered_text: "Rejected behavior",
		}),
	});
	const handlers = createBehavioralArtifactHandlers("u1", {} as Env, deps);

	await handlers.behavioralModel({ rebuild: true });
	const read = await handlers.behavioralModel({});

	assert.equal(read.content[0].text, "Approved behavior");
	const output = structured<{
		available: boolean;
		rebuilt: boolean;
		artifact: { id: string };
	}>(read);
	assert.equal(output.available, true);
	assert.equal(output.rebuilt, false);
	assert.equal(output.artifact.id, "behavior-approved");
});

test("behavioural model without an approved artifact returns structured no content", async () => {
	const deps = consumerHarness();
	const result = await createBehavioralArtifactHandlers(
		"u1",
		{} as Env,
		deps,
	).behavioralModel({});

	assert.deepEqual(structured(result), {
		available: false,
		rebuilt: false,
		status: null,
		artifact: null,
		review_required: false,
	});
});

test("behavioural rebuild failure never echoes the provider message", async () => {
	const deps = consumerHarness({
		rebuildError: new Error("Workers AI upstream said: account key sk-live-42"),
	});
	const result = await createBehavioralArtifactHandlers(
		"u1",
		{} as Env,
		deps,
	).behavioralModel({ rebuild: true });

	assert.equal(result.isError, true);
	assert.doesNotMatch(result.content[0].text, /sk-live-42/);
	assert.match(result.content[0].text, /generation_failed/);
});

test("direct self update writes a canonical fact while person updates stay compatible", async () => {
	const deps = consumerHarness();
	const handlers = createPeopleArtifactHandlers("u1", {} as Env, deps);

	await handlers.updateProfile({
		section: "identity",
		field: "occupation",
		value: "Researcher",
	});
	await handlers.updateProfile({
		person_id: "person-1",
		section: "identity",
		field: "occupation",
		value: "Engineer",
	});

	assert.deepEqual(deps.confirmedFactWrites, [
		{
			userId: "u1",
			section: "identity",
			field: "occupation",
			value: "Researcher",
		},
	]);
	assert.equal(deps.legacySelfBackfillCalls, 1);
	assert.deepEqual(deps.personProfileWrites, [
		{
			personId: "person-1",
			userId: "u1",
			section: "identity",
			content: { occupation: "Engineer" },
		},
	]);
});

test("update_profile accepts the additive self-profile sections", async () => {
	const deps = consumerHarness();
	const handlers = createPeopleArtifactHandlers("u1", {} as Env, deps);

	for (const section of ["preferences", "likes", "goals", "rules"] as const) {
		const result = await handlers.updateProfile({
			section,
			field: "topic",
			value: "Direct answers",
		});
		assert.equal(structured<{ target: string }>(result).target, "self");
	}

	assert.deepEqual(
		deps.confirmedFactWrites.map((write) => write.section),
		["preferences", "likes", "goals", "rules"],
	);
});

test("record observation keeps old calls valid and persists new provenance fields", async () => {
	const deps = consumerHarness();
	const handlers = createBehavioralArtifactHandlers("u1", {} as Env, deps);

	await handlers.recordObservation({
		observation_type: "communication",
		content: "Prefers direct answers",
	});
	await handlers.recordObservation({
		observation_type: "correction",
		content: "Corrected an unsupported claim",
		source_type: "observed",
		confidence: 0.8,
		verified: true,
	});

	assert.deepEqual(deps.observationWrites, [
		{
			source_type: "observed",
			confidence: 0.5,
			verified: false,
		},
		{
			source_type: "observed",
			confidence: 0.8,
			verified: true,
		},
	]);
	assert.equal(deps.observationRows[0].verified_at, null);
	assert.equal(typeof deps.observationRows[1].verified_at, "string");
});

test("registerPeopleTools and registerBehavioralTools keep names and add output schemas", async () => {
	type Registration = {
		name: string;
		config: {
			inputSchema?: { parse: (input: unknown) => any };
			outputSchema?: { parse: (input: unknown) => unknown };
		};
		handler: (input: any) => Promise<any>;
	};
	const registrations: Registration[] = [];
	const registry = {
		tool(name: string, ..._rest: unknown[]) {
			registrations.push({ name, config: {}, handler: async () => ({}) });
		},
		registerTool(
			name: string,
			config: Registration["config"],
			handler: Registration["handler"],
		) {
			registrations.push({ name, config, handler });
		},
	};
	const deps = consumerHarness({
		activeBehavior: artifact({
			kind: "behavioral_profile",
			rendered_text: "Approved behavior",
		}),
	});
	registerPeopleTools(registry as never, {} as Env, "u1", deps);
	registerBehavioralTools(registry as never, {} as Env, "u1", deps);

	const names = registrations.map((registration) => registration.name);
	assert.deepEqual(names, [
		"add_person",
		"search_people",
		"list_people",
		"get_person_profile",
		"update_person",
		"delete_person",
		"update_person_profile",
		"propose_profile_updates",
		"list_pending_profile_updates",
		"apply_pending_profile_updates",
		"reject_pending_profile_update",
		"extract_profile_updates_from_text",
		"audit_profile_health",
		"rebuild_profiles",
		"rebuild_self_profile",
		"update_profile",
		"record_observation",
		"behavioral_model",
		"emotional_context",
		"get_personality",
		"get_personality_mode",
		"build_personality",
		"personality_feedback",
	]);
	const byName = new Map(
		registrations.map((registration) => [registration.name, registration]),
	);

	assert.deepEqual(byName.get("rebuild_self_profile")?.config.inputSchema?.parse({}), {});
	assert.deepEqual(
		byName.get("behavioral_model")?.config.inputSchema?.parse({}),
		{ rebuild: false },
	);
	assert.deepEqual(
		byName.get("record_observation")?.config.inputSchema?.parse({
			observation_type: "communication",
			content: "Prefers direct answers",
		}),
		{
			observation_type: "communication",
			content: "Prefers direct answers",
			source_type: "observed",
			confidence: 0.5,
			verified: false,
		},
	);
	assert.deepEqual(
		byName.get("update_profile")?.config.inputSchema?.parse({
			section: "identity",
			field: "occupation",
			value: "Researcher",
		}),
		{ section: "identity", field: "occupation", value: "Researcher" },
	);
	assert.throws(
		() =>
			byName.get("update_profile")?.config.inputSchema?.parse({
				section: "unknown_section",
				field: "occupation",
				value: "Researcher",
			}),
		/Invalid enum value/,
	);

	for (const [name, input] of [
		["rebuild_self_profile", {}],
		["update_profile", { section: "goals", field: "focus", value: "Ship task 7" }],
		[
			"record_observation",
			{ observation_type: "communication", content: "Prefers direct answers" },
		],
		["behavioral_model", {}],
	] as const) {
		const registration = byName.get(name);
		assert.ok(registration?.config.outputSchema);
		const result = await registration.handler(
			registration.config.inputSchema?.parse(input),
		);
		registration.config.outputSchema.parse(structured(result));
	}
});
