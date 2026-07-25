import assert from "node:assert/strict";
import test from "node:test";

import {
	createSessionArtifactHandlers,
	registerSessionTools,
} from "../src/tools/session";
import { buildAgentContext } from "../src/utils/agents";
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

test("living rebuild publishes validated content and returns coverage", async () => {
	const deps = consumerHarness({
		rebuild: {
			artifact: artifact({
				id: "living-v2",
				kind: "living_summary",
				version: 2,
				status: "published",
				rendered_text: "Trusted summary",
				eligible_source_count: 260,
				selected_source_count: 120,
				source_truncated: true,
			}),
			reused: false,
			published: true,
		},
	});
	const handlers = createSessionArtifactHandlers("u1", {} as Env, deps);

	const result = await handlers.rebuildLivingSummary({});
	const output = structured<{
		artifact_id: string;
		version: number;
		freshness: string;
		coverage: {
			eligible: number;
			selected: number;
			truncated: boolean;
		};
		rendered_text: string;
	}>(result);

	assert.deepEqual(
		{
			artifact_id: output.artifact_id,
			version: output.version,
			freshness: output.freshness,
			coverage: output.coverage,
			rendered_text: output.rendered_text,
		},
		{
			artifact_id: "living-v2",
			version: 2,
			freshness: "current",
			coverage: { eligible: 260, selected: 120, truncated: true },
			rendered_text: "Trusted summary",
		},
	);
});

test("approved candidates appear in a later session and stale content is labelled", async () => {
	const deps = consumerHarness({
		activeLiving: artifact({
			id: "living-stale",
			kind: "living_summary",
			status: "stale",
			rendered_text: "Still readable",
		}),
		activeSelf: artifact({
			id: "self-approved",
			kind: "self_profile",
			rendered_text: "Approved profile",
		}),
		activeBehavior: artifact({
			id: "behavior-approved",
			kind: "behavioral_profile",
			rendered_text: "Approved behavioural profile",
		}),
	});

	const brief = await createSessionArtifactHandlers(
		"u1",
		{} as Env,
		deps,
	).getSessionBrief({});

	assert.match(brief.content[0].text, /Living Summary \(stale\)/);
	assert.match(brief.content[0].text, /Still readable/);
	assert.match(brief.content[0].text, /Approved profile/);
	assert.match(brief.content[0].text, /Approved behavioural profile/);
	const output = structured<{
		artifacts: {
			living_summary: { id: string } | null;
			self_profile: { id: string } | null;
			behavioral_profile: { id: string } | null;
		};
	}>(brief);
	assert.equal(output.artifacts.living_summary?.id, "living-stale");
	assert.equal(output.artifacts.self_profile?.id, "self-approved");
	assert.equal(output.artifacts.behavioral_profile?.id, "behavior-approved");
});

test("legacy-unverified artifacts are readable but labelled everywhere", async () => {
	const deps = consumerHarness({
		activeLiving: artifact({
			id: "living-legacy",
			validation_state: "legacy_unverified",
			rendered_text: "Imported KV summary",
		}),
		rebuild: {
			artifact: artifact({
				id: "living-legacy",
				validation_state: "legacy_unverified",
				rendered_text: "Imported KV summary",
			}),
			reused: true,
			published: true,
		},
	});
	const handlers = createSessionArtifactHandlers("u1", {} as Env, deps);

	const brief = await handlers.getSessionBrief({});
	assert.match(brief.content[0].text, /Living Summary \(legacy-unverified\)/);

	const rebuild = await handlers.rebuildLivingSummary({});
	assert.equal(
		structured<{ freshness: string; validation_state: string }>(rebuild).freshness,
		"legacy-unverified",
	);
	assert.equal(
		structured<{ validation_state: string }>(rebuild).validation_state,
		"legacy_unverified",
	);
});

test("no active living summary returns a structured no-content success", async () => {
	const deps = consumerHarness();
	const handlers = createSessionArtifactHandlers("u1", {} as Env, deps);

	const result = await handlers.getLivingSummary({});
	assert.deepEqual(structured(result), { available: false, artifact: null });
	assert.match(result.content[0].text, /No living summary exists yet/);
});

test("tombstoned and candidate versions never reach the session brief", async () => {
	const deps = consumerHarness({
		activeLiving: artifact({
			id: "living-tombstoned",
			status: "tombstoned",
			rendered_text: "Deleted evidence summary",
		}),
		activeSelf: artifact({
			id: "self-candidate",
			kind: "self_profile",
			status: "candidate",
			rendered_text: "Unapproved self",
		}),
	});

	const brief = await createSessionArtifactHandlers(
		"u1",
		{} as Env,
		deps,
	).getSessionBrief({});

	assert.doesNotMatch(brief.content[0].text, /Deleted evidence summary/);
	assert.doesNotMatch(brief.content[0].text, /Unapproved self/);
	const output = structured<{
		artifacts: { living_summary: unknown; self_profile: unknown };
	}>(brief);
	assert.equal(output.artifacts.living_summary, null);
	assert.equal(output.artifacts.self_profile, null);
});

test("model failure leaves the current living summary in place", async () => {
	const deps = consumerHarness({
		activeLiving: artifact({
			id: "living-current",
			rendered_text: "Previously approved summary",
		}),
		rebuildError: new Error("Workers AI upstream said: token abc123 leaked"),
	});
	const handlers = createSessionArtifactHandlers("u1", {} as Env, deps);

	const failure = await handlers.rebuildLivingSummary({});
	assert.equal(failure.isError, true);
	assert.doesNotMatch(failure.content[0].text, /token abc123/);
	assert.match(failure.content[0].text, /generation_failed/);
	assert.equal("structuredContent" in failure, false);

	const after = await handlers.getLivingSummary({});
	assert.equal(after.content[0].text, "Previously approved summary");
	assert.equal(
		structured<{ artifact: { id: string } }>(after).artifact.id,
		"living-current",
	);
});

test("agent context reads all three active artifacts and excludes candidates", async () => {
	const deps = consumerHarness({
		activeLiving: artifact({
			id: "living",
			kind: "living_summary",
			rendered_text: "D1 living",
		}),
		activeSelf: artifact({
			id: "self",
			kind: "self_profile",
			rendered_text: "D1 self",
		}),
		activeBehavior: artifact({
			id: "behavior",
			kind: "behavioral_profile",
			rendered_text: "Approved behavior",
		}),
		behaviorCandidate: artifact({
			id: "behavior-candidate",
			kind: "behavioral_profile",
			status: "candidate",
			rendered_text: "Unapproved behavior",
		}),
		legacyLivingSummary: "Legacy KV living",
		legacySelfProfile: "Legacy static self",
	});

	const context = await buildAgentContext(
		"u1",
		"query",
		{} as Env,
		{ artifacts: deps },
	);

	assert.equal(context.summary, "D1 living");
	assert.equal(context.selfProfile, "D1 self");
	assert.equal(context.behavioralProfile, "Approved behavior");
	assert.notEqual(context.behavioralProfile, "Unapproved behavior");
});

test("registerSessionTools upgrades three contracts without changing names or defaults", async () => {
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
		activeLiving: artifact({ rendered_text: "Trusted" }),
	});
	registerSessionTools(registry as never, {} as Env, "u1", deps);

	assert.deepEqual(
		registrations.map((registration) => registration.name),
		[
			"get_session_brief",
			"append_session_log",
			"append_session_intent",
			"session_close",
			"session_audit",
			"session_list",
			"check_write_activity",
			"get_living_summary",
			"rebuild_living_summary",
			"update_context_current",
		],
	);
	const byName = new Map(
		registrations.map((registration) => [registration.name, registration]),
	);
	for (const [name, input] of [
		["get_session_brief", {}],
		["get_living_summary", {}],
		["rebuild_living_summary", {}],
	] as const) {
		const registration = byName.get(name);
		assert.ok(registration?.config.outputSchema);
		assert.deepEqual(registration.config.inputSchema?.parse(input), {});
		const result = await registration.handler(
			registration.config.inputSchema?.parse(input),
		);
		registration.config.outputSchema.parse(structured(result));
	}
	assert.deepEqual(
		byName.get("get_session_brief")?.config.inputSchema?.parse({ session_id: "s1" }),
		{ session_id: "s1" },
	);
});
