import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DerivedArtifact, DerivedArtifactDetail } from "../types";
import {
	getDerivedArtifact,
	listDerivedArtifacts,
	restoreDerivedArtifact,
	reviewDerivedArtifact,
} from "../utils/artifact-service";
import { toolError, toolStructured } from "../utils/tool-result";

export type DerivedArtifactToolDependencies = {
	listDerivedArtifacts: typeof listDerivedArtifacts;
	getDerivedArtifact: typeof getDerivedArtifact;
	reviewDerivedArtifact: typeof reviewDerivedArtifact;
	restoreDerivedArtifact: typeof restoreDerivedArtifact;
};

const DEFAULT_DEPS: DerivedArtifactToolDependencies = {
	listDerivedArtifacts,
	getDerivedArtifact,
	reviewDerivedArtifact,
	restoreDerivedArtifact,
};

const SAFE_ARTIFACT_ERRORS = new Set([
	"Derived artifact not found",
	"Artifact not found",
	"Invalid cursor",
	"Only candidates can be reviewed",
	"Only validated candidates can be reviewed",
	"Living summaries publish through rebuild",
	"reason is required for rejection",
	"Evidence changed; rebuild the candidate",
	"reason is required",
	"Tombstoned content cannot be restored",
	"Only previously published artifacts can be restored",
	"Legacy-unverified content cannot be restored",
	"Historical artifact content is unavailable",
	"Historical evidence is missing or changed",
]);

function artifactToolError(error: unknown) {
	const candidate = error instanceof Error ? error.message : "";
	const message = SAFE_ARTIFACT_ERRORS.has(candidate)
		? candidate
		: "Derived artifact operation failed";
	return toolError(new Error(message));
}

const claimSchema = z
	.object({
		id: z.string(),
		section: z.string(),
		text: z.string(),
		confidence: z.number().min(0).max(1),
		provenance: z.enum(["stated", "observed", "inferred"]),
		sensitivity: z.enum(["normal", "sensitive"]),
		citations: z.array(
			z.object({
				source_kind: z.enum([
					"memory",
					"profile_fact",
					"behavioral_observation",
					"personality_feedback",
				]),
				source_id: z.string(),
			}),
		),
	})
	.strict();

const artifactViewSchema = z
	.object({
		artifact_id: z.string(),
		kind: z.enum(["living_summary", "self_profile", "behavioral_profile"]),
		version: z.number().int().positive(),
		status: z.enum([
			"candidate",
			"published",
			"stale",
			"superseded",
			"rejected",
			"tombstoned",
		]),
		validation_state: z.enum(["validated", "legacy_unverified"]),
		rendered_text: z.string().nullable(),
		claims: z.array(claimSchema),
		source_watermark: z.string().nullable(),
		evidence_generation: z.number().int().nonnegative(),
		coverage: z.object({
			eligible_sources: z.number().int().nonnegative(),
			selected_sources: z.number().int().nonnegative(),
			source_truncated: z.boolean(),
		}),
		content_sha256: z
			.string()
			.regex(/^[0-9a-f]{64}$/)
			.nullable(),
		model: z.string().nullable(),
		prompt_version: z.string(),
		validation: z.record(z.unknown()),
		supersedes_id: z.string().nullable(),
		created_at: z.string(),
		published_at: z.string().nullable(),
		reviewed_at: z.string().nullable(),
		reviewed_by: z.string().nullable(),
	})
	.strict();

const artifactPreviewMetadataSchema = artifactViewSchema
	.omit({ rendered_text: true, claims: true, validation: true })
	.strip();
const artifactPreviewSchema = artifactPreviewMetadataSchema
	.extend({ preview: z.string().nullable() })
	.strict();

const sourceViewSchema = z
	.object({
		claim_id: z.string(),
		source_kind: z.enum([
			"memory",
			"profile_fact",
			"behavioral_observation",
			"personality_feedback",
		]),
		source_id: z.string(),
		source_updated_at: z.string(),
		source_sha256: z.string().regex(/^[0-9a-f]{64}$/),
		citation_role: z.literal("supporting"),
	})
	.strict();

const eventViewSchema = z
	.object({
		event_id: z.string(),
		event_type: z.string(),
		reason_code: z.string().nullable(),
		actor: z.string(),
		source_watermark: z.string().nullable(),
		metadata: z.record(z.unknown()),
		created_at: z.string(),
	})
	.strict();

const listOutputSchema = z.object({
	items: z.array(artifactPreviewSchema),
	next_cursor: z.string().nullable(),
});
const getOutputSchema = z.object({
	artifact: artifactViewSchema,
	sources: z.array(sourceViewSchema),
	events: z.array(eventViewSchema),
});
const mutationOutputSchema = z.object({ artifact: artifactViewSchema });

function toArtifactView(artifact: DerivedArtifact) {
	return artifactViewSchema.parse({
		artifact_id: artifact.id,
		kind: artifact.kind,
		version: artifact.version,
		status: artifact.status,
		validation_state: artifact.validation_state,
		rendered_text: artifact.status === "tombstoned" ? null : artifact.rendered_text,
		claims: artifact.status === "tombstoned" ? [] : artifact.claims,
		source_watermark: artifact.source_watermark,
		evidence_generation: artifact.evidence_generation,
		coverage: {
			eligible_sources: artifact.eligible_source_count,
			selected_sources: artifact.selected_source_count,
			source_truncated: artifact.source_truncated,
		},
		content_sha256: artifact.content_sha256,
		model: artifact.model,
		prompt_version: artifact.prompt_version,
		validation: artifact.validation,
		supersedes_id: artifact.supersedes_id,
		created_at: artifact.created_at,
		published_at: artifact.published_at,
		reviewed_at: artifact.reviewed_at,
		reviewed_by: artifact.reviewed_by,
	});
}

function toArtifactPreview(artifact: DerivedArtifact) {
	const view = toArtifactView(artifact);
	const metadata = artifactPreviewMetadataSchema.parse(view);
	return artifactPreviewSchema.parse({
		...metadata,
		preview: view.rendered_text ? view.rendered_text.slice(0, 240) : null,
	});
}

function toArtifactDetail(detail: DerivedArtifactDetail) {
	return getOutputSchema.parse({
		artifact: toArtifactView(detail.artifact),
		sources:
			detail.artifact.status === "tombstoned"
				? []
				: detail.sources.map((source) => ({
						claim_id: source.claim_id,
						source_kind: source.source_kind,
						source_id: source.source_id,
						source_updated_at: source.source_updated_at,
						source_sha256: source.source_sha256,
						citation_role: source.citation_role,
					})),
		events: detail.events.map((event) => ({
			event_id: event.id,
			event_type: event.event_type,
			reason_code: event.reason_code,
			actor: event.actor,
			source_watermark: event.source_watermark,
			metadata: event.metadata,
			created_at: event.created_at,
		})),
	});
}

const listInputSchema = z
	.object({
		kind: z.enum(["living_summary", "self_profile", "behavioral_profile"]).optional(),
		status: z
			.enum(["candidate", "published", "stale", "superseded", "rejected", "tombstoned"])
			.optional(),
		cursor: z.string().min(1).max(500).optional(),
		limit: z.number().int().min(1).max(50).default(20),
	})
	.strict();
const getInputSchema = z.object({ artifact_id: z.string().min(1).max(200) }).strict();
const reviewInputSchema = z
	.object({
		artifact_id: z.string().min(1).max(200),
		decision: z.enum(["approve", "reject"]),
		reason: z.string().trim().min(1).max(500).optional(),
	})
	.strict()
	.superRefine((value, context) => {
		if (value.decision === "reject" && !value.reason) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["reason"],
				message: "reason is required when rejecting an artifact",
			});
		}
	});
const restoreInputSchema = z
	.object({
		artifact_id: z.string().min(1).max(200),
		reason: z.string().trim().min(1).max(500),
	})
	.strict();

export function createDerivedArtifactHandlers(
	userId: string,
	env: Env,
	deps: DerivedArtifactToolDependencies = DEFAULT_DEPS,
) {
	return {
		list: async (input: z.infer<typeof listInputSchema>) => {
			try {
				const page = await deps.listDerivedArtifacts(userId, env, input);
				const structuredContent = {
					items: page.items.map(toArtifactPreview),
					next_cursor: page.nextCursor,
				};
				return toolStructured(
					`Found ${structuredContent.items.length} derived artifact versions.${
						page.nextCursor ? " More versions are available." : ""
					}`,
					structuredContent,
				);
			} catch (error) {
				return artifactToolError(error);
			}
		},
		get: async ({ artifact_id }: z.infer<typeof getInputSchema>) => {
			try {
				const detail = await deps.getDerivedArtifact(artifact_id, userId, env);
				if (!detail) throw new Error("Derived artifact not found");
				const structuredContent = toArtifactDetail(detail);
				const availability =
					detail.artifact.status === "tombstoned"
						? "Content is unavailable because this version is tombstoned."
						: (detail.artifact.rendered_text ?? "This artifact has no rendered text.");
				return toolStructured(
					`${detail.artifact.kind} v${detail.artifact.version} is ${detail.artifact.status}. ${availability}`,
					structuredContent,
				);
			} catch (error) {
				return artifactToolError(error);
			}
		},
		review: async (input: z.infer<typeof reviewInputSchema>) => {
			try {
				const reviewed = await deps.reviewDerivedArtifact(
					input.artifact_id,
					userId,
					input.decision,
					input.reason,
					"mcp:user",
					env,
				);
				return toolStructured(
					`Artifact ${reviewed.id} ${
						input.decision === "approve" ? "approved" : "rejected"
					} as version ${reviewed.version}.`,
					{ artifact: toArtifactView(reviewed) },
				);
			} catch (error) {
				return artifactToolError(error);
			}
		},
		restore: async (input: z.infer<typeof restoreInputSchema>) => {
			try {
				const restored = await deps.restoreDerivedArtifact(
					input.artifact_id,
					userId,
					input.reason,
					"mcp:user",
					env,
				);
				return toolStructured(
					`Restored ${input.artifact_id} as new published artifact ${restored.id}, version ${restored.version}.`,
					{ artifact: toArtifactView(restored) },
				);
			} catch (error) {
				return artifactToolError(error);
			}
		},
	};
}

export function registerDerivedArtifactTools(
	server: McpServer,
	env: Env,
	userId: string,
	deps: DerivedArtifactToolDependencies = DEFAULT_DEPS,
) {
	const handlers = createDerivedArtifactHandlers(userId, env, deps);

	server.registerTool(
		"list_derived_artifacts",
		{
			description:
				"List versioned derived artifacts for this tenant with bounded cursor pagination.",
			inputSchema: listInputSchema,
			outputSchema: listOutputSchema,
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		handlers.list,
	);
	server.registerTool(
		"get_derived_artifact",
		{
			description:
				"Read one derived artifact, its validated citations, lifecycle metadata, and audit events.",
			inputSchema: getInputSchema,
			outputSchema: getOutputSchema,
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		handlers.get,
	);
	server.registerTool(
		"review_derived_artifact",
		{
			description:
				"Approve or reject a validated self-profile or behavioural-profile candidate.",
			inputSchema: reviewInputSchema,
			outputSchema: mutationOutputSchema,
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: false,
				openWorldHint: false,
			},
		},
		handlers.review,
	);
	server.registerTool(
		"restore_derived_artifact",
		{
			description:
				"Clone a still-supported historical artifact into a new published version.",
			inputSchema: restoreInputSchema,
			outputSchema: mutationOutputSchema,
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: false,
				openWorldHint: false,
			},
		},
		handlers.restore,
	);
}
