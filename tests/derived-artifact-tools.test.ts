import assert from "node:assert/strict";
import test from "node:test";

import type { DerivedArtifact, DerivedArtifactDetail } from "../src/types";
import {
	type DerivedArtifactToolDependencies,
	registerDerivedArtifactTools,
} from "../src/tools/derived-artifacts";

type Registration = {
	name: string;
	config: {
		inputSchema: { parse(input: unknown): unknown };
		outputSchema: { parse(input: unknown): unknown };
		annotations: {
			readOnlyHint: boolean;
			destructiveHint: boolean;
			idempotentHint: boolean;
			openWorldHint: boolean;
		};
	};
	handler(input: never): Promise<{
		content: Array<{ type: "text"; text: string }>;
		structuredContent?: Record<string, unknown>;
		isError?: boolean;
	}>;
};

const artifact: DerivedArtifact = {
	id: "artifact-self-2",
	userId: "tenant-a",
	kind: "self_profile",
	version: 2,
	status: "candidate",
	validation_state: "validated",
	claims: [
		{
			id: "claim-1",
			section: "identity",
			text: "The user prefers concise release notes.",
			confidence: 1,
			provenance: "stated",
			sensitivity: "normal",
			citations: [{ source_kind: "profile_fact", source_id: "fact-1" }],
		},
	],
	rendered_text: "The user prefers concise release notes.",
	source_watermark: "watermark-1",
	evidence_generation: 3,
	eligible_source_count: 1,
	selected_source_count: 1,
	source_truncated: false,
	content_sha256: "a".repeat(64),
	model: "@cf/zai-org/glm-4.7-flash",
	prompt_version: "trusted-artifacts-v1",
	validation: { citations_valid: true },
	supersedes_id: null,
	created_at: "2026-07-24T04:00:00.000Z",
	published_at: null,
	reviewed_at: null,
	reviewed_by: null,
};

const detail: DerivedArtifactDetail = {
	artifact,
	sources: [
		{
			artifact_id: artifact.id,
			userId: "tenant-a",
			claim_id: "claim-1",
			source_kind: "profile_fact",
			source_id: "fact-1",
			source_updated_at: "2026-07-24T03:00:00.000Z",
			source_sha256: "b".repeat(64),
			citation_role: "supporting",
		},
	],
	events: [
		{
			id: "event-1",
			userId: "tenant-a",
			artifact_id: artifact.id,
			kind: "self_profile",
			event_type: "generated",
			reason_code: null,
			actor: "system",
			source_watermark: "watermark-1",
			metadata: {},
			created_at: "2026-07-24T04:00:00.000Z",
		},
	],
};

function harness() {
	const calls: Array<{ name: string; args: unknown[] }> = [];
	const deps: DerivedArtifactToolDependencies = {
		listDerivedArtifacts: async (...args) => {
			calls.push({ name: "list", args });
			return { items: [artifact], nextCursor: "cursor-2" };
		},
		getDerivedArtifact: async (...args) => {
			calls.push({ name: "get", args });
			return detail;
		},
		reviewDerivedArtifact: async (...args) => {
			calls.push({ name: "review", args });
			return {
				...artifact,
				status: args[2] === "approve" ? "published" : "rejected",
				reviewed_at: "2026-07-24T05:00:00.000Z",
				reviewed_by: "mcp:user",
			};
		},
		restoreDerivedArtifact: async (...args) => {
			calls.push({ name: "restore", args });
			return {
				...artifact,
				id: "artifact-self-3",
				version: 3,
				status: "published",
				supersedes_id: artifact.id,
				published_at: "2026-07-24T05:10:00.000Z",
			};
		},
	};
	return { calls, deps };
}

function capture(deps: DerivedArtifactToolDependencies): Registration[] {
	const registrations: Registration[] = [];
	const server = {
		registerTool(
			name: string,
			config: Registration["config"],
			handler: Registration["handler"],
		) {
			registrations.push({ name, config, handler });
		},
	};
	registerDerivedArtifactTools(server as never, {} as Env, "tenant-a", deps);
	return registrations;
}

test("registers the four exact artifact-management contracts and safety annotations", () => {
	const { deps } = harness();
	const registrations = capture(deps);
	assert.deepEqual(
		registrations.map(({ name }) => name),
		[
			"list_derived_artifacts",
			"get_derived_artifact",
			"review_derived_artifact",
			"restore_derived_artifact",
		],
	);
	assert.deepEqual(registrations[0].config.annotations, {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	});
	assert.deepEqual(registrations[1].config.annotations, {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	});
	for (const registration of registrations.slice(2)) {
		assert.deepEqual(registration.config.annotations, {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: false,
		});
	}
	assert.deepEqual(registrations[0].config.inputSchema.parse({}), { limit: 20 });
	assert.throws(
		() => registrations[0].config.inputSchema.parse({ limit: 51 }),
		/Number must be less than or equal to 50/,
	);
	assert.throws(
		() =>
			registrations[2].config.inputSchema.parse({
				artifact_id: artifact.id,
				decision: "reject",
			}),
		/reason is required when rejecting an artifact/,
	);
	assert.throws(
		() =>
			registrations[3].config.inputSchema.parse({
				artifact_id: artifact.id,
				reason: "x".repeat(501),
			}),
		/String must contain at most 500 character/,
	);
});

test("scopes every service call to the current tenant and validates every output", async () => {
	const { calls, deps } = harness();
	const registrations = capture(deps);
	const byName = new Map(registrations.map((item) => [item.name, item]));
	const invocations = [
		["list_derived_artifacts", { kind: "self_profile", limit: 20 }],
		["get_derived_artifact", { artifact_id: artifact.id }],
		[
			"review_derived_artifact",
			{ artifact_id: artifact.id, decision: "approve" },
		],
		[
			"restore_derived_artifact",
			{ artifact_id: artifact.id, reason: "Restore the last confirmed profile." },
		],
	] as const;

	for (const [name, rawInput] of invocations) {
		const registration = byName.get(name);
		assert.ok(registration);
		const input = registration.config.inputSchema.parse(rawInput);
		const result = await registration.handler(input as never);
		assert.equal(result.isError, undefined);
		assert.ok(result.content[0]?.text.trim());
		assert.ok(result.structuredContent);
		registration.config.outputSchema.parse(result.structuredContent);
	}

	assert.equal(calls[0].name, "list");
	assert.equal(calls[0].args[0], "tenant-a");
	assert.deepEqual(calls[0].args[2], { kind: "self_profile", limit: 20 });
	assert.equal(calls[1].name, "get");
	assert.equal(calls[1].args[0], artifact.id);
	assert.equal(calls[1].args[1], "tenant-a");
	assert.equal(calls[2].name, "review");
	assert.equal(calls[2].args[0], artifact.id);
	assert.equal(calls[2].args[1], "tenant-a");
	assert.equal(calls[2].args[2], "approve");
	assert.equal(calls[2].args[3], undefined);
	assert.equal(calls[2].args[4], "mcp:user");
	assert.equal(calls[3].name, "restore");
	assert.equal(calls[3].args[0], artifact.id);
	assert.equal(calls[3].args[1], "tenant-a");
	assert.equal(calls[3].args[2], "Restore the last confirmed profile.");
	assert.equal(calls[3].args[3], "mcp:user");
});

test("returns a tenant-safe MCP error when an artifact is unavailable", async () => {
	const { deps } = harness();
	deps.getDerivedArtifact = async () => null;
	const registration = capture(deps).find(({ name }) => name === "get_derived_artifact");
	assert.ok(registration);
	const result = await registration.handler({ artifact_id: "foreign-artifact" } as never);
	assert.equal(result.isError, true);
	assert.equal(result.content[0].text, "Error: Derived artifact not found");
	assert.equal(result.structuredContent, undefined);
});

test("does not expose database or model exception text", async () => {
	const { deps } = harness();
	deps.listDerivedArtifacts = async () => {
		throw new Error("D1_ERROR: no such table derived_artifacts");
	};
	const registration = capture(deps).find(({ name }) => name === "list_derived_artifacts");
	assert.ok(registration);
	const result = await registration.handler({ limit: 20 } as never);
	assert.equal(result.isError, true);
	assert.equal(result.content[0].text, "Error: Derived artifact operation failed");
	assert.doesNotMatch(result.content[0].text, /D1_ERROR|derived_artifacts/);
});
