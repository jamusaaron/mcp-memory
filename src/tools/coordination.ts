import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
	COORDINATION_PROVENANCE,
	COUNCIL_ROLES,
	COUNCIL_VOTES,
	type CouncilDecision,
	type CouncilProposal,
	type CouncilVote,
	type CoordinationHandoff,
	type CoordinationHandoffReview,
	type CoordinationLease,
} from "../types";
import {
	buildCoordinationBrief,
	claimCoordinationTask,
	createCouncilProposal,
	getCouncilDecision,
	heartbeatCoordinationTask,
	listVerifiedHandoffs,
	releaseCoordinationTask,
	reviewHandoff,
	runCouncilDecision,
	submitHandoff,
	type CoordinationClock,
	type CoordinationBrief,
} from "../utils/coordination";
import { toolError, toolStructured } from "../utils/tool-result";

const MAX_IDENTIFIER_CHARS = 160;
const MAX_EVIDENCE_ITEMS = 12;

const identifierSchema = z.string().trim().min(1).max(MAX_IDENTIFIER_CHARS);
const nullableIdentifierSchema = identifierSchema.nullable();
const auditActorSchema = identifierSchema
	.refine((actor) => !actor.toLowerCase().startsWith("council:"), {
		message: "council actor labels are reserved",
	})
	.default("mcp:user");
const optionalExpirySchema = z.string().trim().min(1).max(80).nullable().optional();

const handoffSubmitInputSchema = z
	.object({
		to_agent: nullableIdentifierSchema.optional(),
		target_role: nullableIdentifierSchema.optional(),
		summary: z.string().trim().min(1).max(600),
		next_steps: z.string().trim().min(1).max(1_000),
		evidence: z.array(z.string().trim().min(1).max(240)).max(MAX_EVIDENCE_ITEMS).optional(),
		provenance: z.enum(COORDINATION_PROVENANCE),
		confidence: z.number().min(0).max(1),
		expires_at: optionalExpirySchema,
		source_run_id: nullableIdentifierSchema.optional(),
		supersedes_id: nullableIdentifierSchema.optional(),
		actor_id: auditActorSchema,
	})
	.strict();

const handoffListInputSchema = z
	.object({
		agent_id: identifierSchema.optional(),
		target_role: nullableIdentifierSchema.optional(),
		tags: z.array(identifierSchema).max(MAX_EVIDENCE_ITEMS).default([]),
		limit: z.number().int().min(1).max(50).default(20),
	})
	.strict();

const handoffReviewInputSchema = z
	.object({
		handoff_id: identifierSchema,
		verdict: z.enum(["verified", "rejected"]),
		reason: z.string().trim().min(1).max(600),
		actor_id: auditActorSchema,
	})
	.strict();

const taskClaimInputSchema = z
	.object({ task_id: identifierSchema, actor_id: auditActorSchema })
	.strict();
const taskHeartbeatInputSchema = z
	.object({ lease_id: identifierSchema, actor_id: auditActorSchema })
	.strict();
const taskReleaseInputSchema = z
	.object({
		lease_id: identifierSchema,
		final_state: z.enum(["released", "completed", "failed"]).default("released"),
		reason: z.string().trim().min(1).max(600).nullable().optional(),
		result: z.string().trim().min(1).max(1_000).nullable().optional(),
		actor_id: auditActorSchema,
	})
	.strict();

const briefInputSchema = z
	.object({
		agent_id: identifierSchema,
		tags: z.array(identifierSchema).max(MAX_EVIDENCE_ITEMS).default([]),
	})
	.strict();

const proposalCreateInputSchema = z
	.object({
		question: z.string().trim().min(1).max(600),
		options: z.array(z.string().trim().min(1).max(160)).max(8).optional(),
		evidence_ids: z.array(identifierSchema).max(MAX_EVIDENCE_ITEMS).optional(),
		expires_at: optionalExpirySchema,
		supersedes_proposal_id: nullableIdentifierSchema.optional(),
		actor_id: auditActorSchema,
	})
	.strict();
const proposalIdInputSchema = z.object({ proposal_id: identifierSchema }).strict();

const handoffViewSchema = z
	.object({
		id: z.string(),
		from_agent: z.string(),
		to_agent: z.string().nullable(),
		target_role: z.string().nullable(),
		summary: z.string(),
		next_steps: z.string(),
		evidence: z.array(z.string()),
		provenance: z.enum(COORDINATION_PROVENANCE),
		confidence: z.number(),
		state: z.enum(["draft", "submitted", "verified", "rejected", "expired"]),
		expires_at: z.string().nullable(),
		submitted_at: z.string().nullable(),
		content_sha256: z.string(),
		source_run_id: z.string().nullable(),
		supersedes_id: z.string().nullable(),
		actor_id: z.string(),
		created_at: z.string(),
		updated_at: z.string(),
	})
	.strict();

const handoffReviewViewSchema = z
	.object({
		id: z.string(),
		handoff_id: z.string(),
		reviewer_id: z.string(),
		decision: z.enum(["verified", "rejected"]),
		reason: z.string().nullable(),
		evidence: z.array(z.string()),
		actor_id: z.string(),
		created_at: z.string(),
		updated_at: z.string(),
	})
	.strict();

const leaseViewSchema = z
	.object({
		id: z.string(),
		task_id: z.string(),
		lease_id: z.string(),
		holder_id: z.string(),
		state: z.enum(["active", "released", "expired", "completed", "failed"]),
		leased_at: z.string(),
		heartbeat_at: z.string(),
		expires_at: z.string(),
		released_at: z.string().nullable(),
		actor_id: z.string(),
		created_at: z.string(),
		updated_at: z.string(),
	})
	.strict();

const briefItemViewSchema = z
	.object({
		kind: z.enum(["lease", "handoff", "blocker", "outcome"]),
		source_id: z.string(),
		provenance: z.enum(COORDINATION_PROVENANCE),
		trust: z.enum(["active", "verified", "legacy_untrusted"]),
		context_class: z.literal("untrusted_data"),
		untrusted: z.literal(true),
		content: z.string(),
		next_steps: z.string().optional(),
		expires_at: z.string().nullable().optional(),
	})
	.strict();
const briefViewSchema = z
	.object({
		user_id: z.string(),
		agent_id: z.string(),
		generated_at: z.string(),
		items: z.array(briefItemViewSchema),
		total_chars: z.number().int().nonnegative(),
		truncated: z.boolean(),
		prompt: z.string(),
	})
	.strict();

const proposalViewSchema = z
	.object({
		id: z.string(),
		question: z.string(),
		options: z.array(z.string()),
		evidence_ids: z.array(z.string()),
		council_roles: z.array(z.enum(COUNCIL_ROLES)).length(COUNCIL_ROLES.length),
		status: z.enum(["open", "decided", "expired"]),
		expires_at: z.string().nullable(),
		actor_id: z.string(),
		created_at: z.string(),
		updated_at: z.string(),
	})
	.strict();
const voteViewSchema = z
	.object({
		id: z.string(),
		proposal_id: z.string(),
		council_role: z.enum(COUNCIL_ROLES),
		vote: z.enum(COUNCIL_VOTES),
		reason: z.string(),
		evidence_ids: z.array(z.string()),
		source_run_id: z.string().nullable(),
		actor_id: z.string(),
		created_at: z.string(),
		updated_at: z.string(),
	})
	.strict();
const decisionViewSchema = z
	.object({
		proposal: proposalViewSchema,
		votes: z.array(voteViewSchema).max(COUNCIL_ROLES.length),
		outcome: z.enum(["pending", "approved", "rejected", "escalated"]),
		approve_count: z.number().int().nonnegative(),
		reject_count: z.number().int().nonnegative(),
		escalate_count: z.number().int().nonnegative(),
		decided_at: z.string().nullable(),
		synthesis: z.string().nullable(),
		final_event_id: z.string().nullable(),
		supersedes_proposal_id: z.string().nullable(),
	})
	.strict();

const handoffOutputSchema = z.object({ handoff: handoffViewSchema });
const handoffListOutputSchema = z.object({ handoffs: z.array(handoffViewSchema) });
const handoffReviewOutputSchema = z.object({ review: handoffReviewViewSchema });
const leaseOutputSchema = z.object({ lease: leaseViewSchema });
const briefOutputSchema = z.object({ brief: briefViewSchema });
const proposalOutputSchema = z.object({ proposal: proposalViewSchema });
const decisionOutputSchema = z.object({ decision: decisionViewSchema });

const SAFE_COORDINATION_ERRORS = new Set([
	"A handoff requires to_agent or target_role",
	"Handoff not found",
	"Handoff has already been reviewed",
	"An author cannot review their own handoff",
	"Expired handoffs cannot be reviewed",
	"Handoff is no longer reviewable",
	"Coordination task is not available for lease",
	"Not the current coordination lease",
	"Coordination task board is unavailable",
	"Coordination lease storage is unavailable",
	"Council proposal not found",
	"Council proposal is not open for a decision",
	"Council proposal author is not eligible to vote",
	"Council proposal has incomplete vote state",
	"Council proposal has an incomplete prior run",
	"Council evidence is unavailable or not verified",
	"Council proposal expiry could not be recorded",
	"Council decision is already being finalized",
	"Council identities are reserved for fixed server-owned voters",
	"Superseded council proposal not found",
]);

export type CoordinationToolDependencies = {
	submitHandoff: typeof submitHandoff;
	listVerifiedHandoffs: typeof listVerifiedHandoffs;
	reviewHandoff: typeof reviewHandoff;
	claimCoordinationTask: typeof claimCoordinationTask;
	heartbeatCoordinationTask: typeof heartbeatCoordinationTask;
	releaseCoordinationTask: typeof releaseCoordinationTask;
	buildCoordinationBrief: typeof buildCoordinationBrief;
	createCouncilProposal: typeof createCouncilProposal;
	runCouncilDecision: typeof runCouncilDecision;
	getCouncilDecision: typeof getCouncilDecision;
	clock: CoordinationClock;
};

const DEFAULT_DEPS: CoordinationToolDependencies = {
	submitHandoff,
	listVerifiedHandoffs,
	reviewHandoff,
	claimCoordinationTask,
	heartbeatCoordinationTask,
	releaseCoordinationTask,
	buildCoordinationBrief,
	createCouncilProposal,
	runCouncilDecision,
	getCouncilDecision,
	clock: () => new Date(),
};

function coordinationToolError(error: unknown) {
	const candidate = error instanceof Error ? error.message : "";
	return toolError(
		new Error(
			SAFE_COORDINATION_ERRORS.has(candidate) ? candidate : "Coordination operation failed",
		),
	);
}

function toHandoffView(handoff: CoordinationHandoff) {
	return handoffViewSchema.parse({
		id: handoff.id,
		from_agent: handoff.from_agent,
		to_agent: handoff.to_agent,
		target_role: handoff.target_role,
		summary: handoff.summary,
		next_steps: handoff.next_steps,
		evidence: handoff.evidence,
		provenance: handoff.provenance,
		confidence: handoff.confidence,
		state: handoff.state,
		expires_at: handoff.expires_at,
		submitted_at: handoff.submitted_at,
		content_sha256: handoff.content_sha256,
		source_run_id: handoff.source_run_id,
		supersedes_id: handoff.supersedes_id,
		actor_id: handoff.actor_id,
		created_at: handoff.created_at,
		updated_at: handoff.updated_at,
	});
}

function toHandoffReviewView(review: CoordinationHandoffReview) {
	return handoffReviewViewSchema.parse({
		id: review.id,
		handoff_id: review.handoff_id,
		reviewer_id: review.reviewer_id,
		decision: review.decision,
		reason: review.reason,
		evidence: review.evidence,
		actor_id: review.actor_id,
		created_at: review.created_at,
		updated_at: review.updated_at,
	});
}

function toLeaseView(lease: CoordinationLease) {
	return leaseViewSchema.parse({
		id: lease.id,
		task_id: lease.task_id,
		lease_id: lease.lease_id,
		holder_id: lease.holder_id,
		state: lease.state,
		leased_at: lease.leased_at,
		heartbeat_at: lease.heartbeat_at,
		expires_at: lease.expires_at,
		released_at: lease.released_at,
		actor_id: lease.actor_id,
		created_at: lease.created_at,
		updated_at: lease.updated_at,
	});
}

function toProposalView(proposal: CouncilProposal) {
	return proposalViewSchema.parse({
		id: proposal.id,
		question: proposal.question,
		options: proposal.options,
		evidence_ids: proposal.evidence_ids,
		council_roles: proposal.council_roles,
		status: proposal.status,
		expires_at: proposal.expires_at,
		actor_id: proposal.actor_id,
		created_at: proposal.created_at,
		updated_at: proposal.updated_at,
	});
}

function toVoteView(vote: CouncilVote) {
	return voteViewSchema.parse({
		id: vote.id,
		proposal_id: vote.proposal_id,
		council_role: vote.council_role,
		vote: vote.vote,
		reason: vote.reason,
		evidence_ids: vote.evidence_ids,
		source_run_id: vote.source_run_id,
		actor_id: vote.actor_id,
		created_at: vote.created_at,
		updated_at: vote.updated_at,
	});
}

function toDecisionView(decision: CouncilDecision) {
	return decisionViewSchema.parse({
		proposal: toProposalView(decision.proposal),
		votes: decision.votes.map(toVoteView),
		outcome: decision.outcome,
		approve_count: decision.approve_count,
		reject_count: decision.reject_count,
		escalate_count: decision.escalate_count,
		decided_at: decision.decided_at,
		synthesis: decision.synthesis,
		final_event_id: decision.final_event_id,
		supersedes_proposal_id: decision.supersedes_proposal_id,
	});
}

function toBriefView(brief: CoordinationBrief) {
	return briefViewSchema.parse(brief);
}

export function createCoordinationHandlers(
	userId: string,
	env: Env,
	deps: CoordinationToolDependencies = DEFAULT_DEPS,
) {
	return {
		handoffSubmit: async (input: z.infer<typeof handoffSubmitInputSchema>) => {
			try {
				const { actor_id, ...handoffInput } = input;
				const handoff = await deps.submitHandoff(
					handoffInput,
					userId,
					actor_id,
					env,
					deps.clock,
				);
				return toolStructured(`Submitted coordination handoff ${handoff.id}.`, {
					handoff: toHandoffView(handoff),
				});
			} catch (error) {
				return coordinationToolError(error);
			}
		},
		handoffList: async (input: z.infer<typeof handoffListInputSchema>) => {
			try {
				const handoffs = await deps.listVerifiedHandoffs(userId, env, deps.clock, input);
				return toolStructured(`Found ${handoffs.length} verified coordination handoffs.`, {
					handoffs: handoffs.map(toHandoffView),
				});
			} catch (error) {
				return coordinationToolError(error);
			}
		},
		handoffReview: async (input: z.infer<typeof handoffReviewInputSchema>) => {
			try {
				const review = await deps.reviewHandoff(
					input.handoff_id,
					input.verdict,
					input.reason,
					userId,
					input.actor_id,
					env,
					deps.clock,
				);
				return toolStructured(`Recorded ${review.decision} handoff review ${review.id}.`, {
					review: toHandoffReviewView(review),
				});
			} catch (error) {
				return coordinationToolError(error);
			}
		},
		taskClaim: async (input: z.infer<typeof taskClaimInputSchema>) => {
			try {
				const lease = await deps.claimCoordinationTask(
					input.task_id,
					userId,
					input.actor_id,
					env,
					deps.clock,
				);
				return toolStructured(`Claimed coordination lease ${lease.lease_id}.`, {
					lease: toLeaseView(lease),
				});
			} catch (error) {
				return coordinationToolError(error);
			}
		},
		taskHeartbeat: async (input: z.infer<typeof taskHeartbeatInputSchema>) => {
			try {
				const lease = await deps.heartbeatCoordinationTask(
					input.lease_id,
					userId,
					input.actor_id,
					env,
					deps.clock,
				);
				return toolStructured(`Renewed coordination lease ${lease.lease_id}.`, {
					lease: toLeaseView(lease),
				});
			} catch (error) {
				return coordinationToolError(error);
			}
		},
		taskRelease: async (input: z.infer<typeof taskReleaseInputSchema>) => {
			try {
				const lease = await deps.releaseCoordinationTask(
					input.lease_id,
					userId,
					input.actor_id,
					env,
					deps.clock,
					{
						final_state: input.final_state,
						reason: input.reason,
						result: input.result,
					},
				);
				return toolStructured(`Released coordination lease ${lease.lease_id}.`, {
					lease: toLeaseView(lease),
				});
			} catch (error) {
				return coordinationToolError(error);
			}
		},
		brief: async (input: z.infer<typeof briefInputSchema>) => {
			try {
				const brief = await deps.buildCoordinationBrief(
					userId,
					input.agent_id,
					input.tags,
					env,
					deps.clock,
				);
				return toolStructured(`Built a coordination brief for ${brief.agent_id}.`, {
					brief: toBriefView(brief),
				});
			} catch (error) {
				return coordinationToolError(error);
			}
		},
		proposalCreate: async (input: z.infer<typeof proposalCreateInputSchema>) => {
			try {
				const { actor_id, ...proposalInput } = input;
				const proposal = await deps.createCouncilProposal(
					proposalInput,
					userId,
					actor_id,
					env,
					deps.clock,
				);
				return toolStructured(`Created council proposal ${proposal.id}.`, {
					proposal: toProposalView(proposal),
				});
			} catch (error) {
				return coordinationToolError(error);
			}
		},
		councilDecide: async (input: z.infer<typeof proposalIdInputSchema>) => {
			try {
				const decision = await deps.runCouncilDecision(
					input.proposal_id,
					userId,
					env,
					deps.clock,
				);
				return toolStructured(`Recorded council outcome: ${decision.outcome}.`, {
					decision: toDecisionView(decision),
				});
			} catch (error) {
				return coordinationToolError(error);
			}
		},
		councilDecisionGet: async (input: z.infer<typeof proposalIdInputSchema>) => {
			try {
				const decision = await deps.getCouncilDecision(
					input.proposal_id,
					userId,
					env,
					deps.clock,
				);
				return toolStructured(`Retrieved council outcome: ${decision.outcome}.`, {
					decision: toDecisionView(decision),
				});
			} catch (error) {
				return coordinationToolError(error);
			}
		},
	};
}

export function registerCoordinationTools(
	server: McpServer,
	env: Env,
	userId: string,
	deps: CoordinationToolDependencies = DEFAULT_DEPS,
) {
	const handlers = createCoordinationHandlers(userId, env, deps);
	const readOnlyAnnotations = {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	};
	const mutationAnnotations = {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: false,
	};

	server.registerTool(
		"coordination_handoff_submit",
		{
			description: "Submit a bounded, tenant-scoped handoff for independent review.",
			inputSchema: handoffSubmitInputSchema,
			outputSchema: handoffOutputSchema,
			annotations: mutationAnnotations,
		},
		handlers.handoffSubmit,
	);
	server.registerTool(
		"coordination_handoff_list",
		{
			description: "List verified, unexpired handoffs relevant to this tenant.",
			inputSchema: handoffListInputSchema,
			outputSchema: handoffListOutputSchema,
			annotations: readOnlyAnnotations,
		},
		handlers.handoffList,
	);
	server.registerTool(
		"coordination_handoff_review",
		{
			description: "Record an independent verification or rejection of a submitted handoff.",
			inputSchema: handoffReviewInputSchema,
			outputSchema: handoffReviewOutputSchema,
			annotations: mutationAnnotations,
		},
		handlers.handoffReview,
	);
	server.registerTool(
		"coordination_task_claim",
		{
			description: "Claim a recoverable five-minute lease for a tenant-scoped task.",
			inputSchema: taskClaimInputSchema,
			outputSchema: leaseOutputSchema,
			annotations: mutationAnnotations,
		},
		handlers.taskClaim,
	);
	server.registerTool(
		"coordination_task_heartbeat",
		{
			description: "Renew the caller's current tenant-scoped task lease.",
			inputSchema: taskHeartbeatInputSchema,
			outputSchema: leaseOutputSchema,
			annotations: mutationAnnotations,
		},
		handlers.taskHeartbeat,
	);
	server.registerTool(
		"coordination_task_release",
		{
			description:
				"Release, complete, or fail the caller's current tenant-scoped task lease.",
			inputSchema: taskReleaseInputSchema,
			outputSchema: leaseOutputSchema,
			annotations: mutationAnnotations,
		},
		handlers.taskRelease,
	);
	server.registerTool(
		"coordination_brief",
		{
			description: "Build bounded, labelled untrusted coordination context for an agent.",
			inputSchema: briefInputSchema,
			outputSchema: briefOutputSchema,
			annotations: readOnlyAnnotations,
		},
		handlers.brief,
	);
	server.registerTool(
		"council_proposal_create",
		{
			description:
				"Create an immutable seven-role council proposal without dispatching an action.",
			inputSchema: proposalCreateInputSchema,
			outputSchema: proposalOutputSchema,
			annotations: mutationAnnotations,
		},
		handlers.proposalCreate,
	);
	server.registerTool(
		"council_decide",
		{
			description: "Run the fixed seven-role council and record its auditable decision only.",
			inputSchema: proposalIdInputSchema,
			outputSchema: decisionOutputSchema,
			annotations: mutationAnnotations,
		},
		handlers.councilDecide,
	);
	server.registerTool(
		"council_decision_get",
		{
			description:
				"Read a persisted council decision, votes, reasons, and evidence references.",
			inputSchema: proposalIdInputSchema,
			outputSchema: decisionOutputSchema,
			annotations: readOnlyAnnotations,
		},
		handlers.councilDecisionGet,
	);
}
