export const CATEGORIES = [
    "identity", "relationship", "projects", "cybersec", "finance",
    "ai", "health", "rules", "creative", "preferences", "likes",
    "goals", "knowledge", "corrections",
] as const;
export type Category = typeof CATEGORIES[number];

export const LAYERS = ["core", "long_embedded", "mid_ground", "current"] as const;
export type Layer = typeof LAYERS[number];

export const SOURCE_TYPES = ["stated", "observed", "inferred"] as const;
export type SourceType = typeof SOURCE_TYPES[number];

export const PROFILE_SECTIONS = [
    "identity", "personality", "psychology", "behavior", "history", "relationship",
] as const;
export type ProfileSection = typeof PROFILE_SECTIONS[number];

export interface Memory {
    id: string;
    userId: string;
    category: Category;
    layer: Layer;
    subject: string | null;
    text: string;
    tags: string[];
    triggers: string[];
    confidence: number;
    salience: number;
    emotion_weight: number;
    source_type: SourceType;
    linked_people: string[];
    embedding_status: "pending" | "embedded";
    suppressed: boolean;
    suppression_reason: string | null;
    pinned: boolean;
    access_count: number;
    last_accessed: string | null;
    last_verified: string | null;
    created_at: string;
    updated_at: string;
}

export interface Person {
    id: string;
    userId: string;
    name: string;
    aliases: string[];
    created_at: string;
    updated_at: string;
}

export interface PersonProfile {
    id: string;
    personId: string;
    userId: string;
    section: ProfileSection;
    content: Record<string, unknown>;
    created_at: string;
    updated_at: string;
}

export interface PendingUpdate {
    id: string;
    userId: string;
    personId: string | null;
    update_type: string;
    field: string;
    proposed_value: string;
    confidence: number;
    source: string | null;
    status: "pending" | "applied" | "rejected";
    created_at: string;
}

export interface SessionLog {
    id: string;
    userId: string;
    session_id: string;
    entry_type: "log" | "intent" | "close" | "audit";
    content: string;
    created_at: string;
}

export interface Uncertainty {
    id: string;
    userId: string;
    question: string;
    context: string | null;
    status: "open" | "answered" | "dismissed";
    answer: string | null;
    created_at: string;
    answered_at: string | null;
}

export interface AiNote {
    id: string;
    userId: string;
    agent_id: string;
    namespace: string;
    key: string;
    content: string;
    created_at: string;
    updated_at: string;
}

export interface Transcript {
    id: string;
    userId: string;
    source: string;
    content: string;
    processed: boolean;
    extracted_count: number;
    created_at: string;
}

export interface BehavioralObservation {
	id: string;
	userId: string;
	observation_type: string;
	content: string;
	context: string | null;
	source_type: SourceType;
	confidence: number;
	status: "active" | "rejected" | "superseded" | "tombstoned";
	verified_at: string | null;
	created_at: string;
}

export interface PersonalityFeedback {
    id: string;
    userId: string;
    persona: string;
    tone: string | null;
    mode: string | null;
    situation: string | null;
    outcome: string | null;
    feedback_score: number | null;
    created_at: string;
}

export interface MemoryIndex {
    total: number;
    by_category: Record<string, number>;
    by_layer: Record<string, number>;
    embedded: number;
    pending_embedding: number;
    suppressed: number;
}

export const AGENT_TASK_STATUSES = [
    "open", "claimed", "done", "failed", "cancelled",
] as const;
export type AgentTaskStatus = typeof AGENT_TASK_STATUSES[number];

export interface AgentTask {
    id: string;
    userId: string;
    title: string;
    description: string | null;
    status: AgentTaskStatus;
    priority: number;
    assigned_agent: string | null;
    claimed_by: string | null;
    result: string | null;
    tags: string[];
    created_at: string;
    updated_at: string;
    completed_at: string | null;
}

export interface AgentPresence {
    id: string;
    userId: string;
    agent_id: string;
    role: string;
    status: string;
    capabilities: string[];
    last_seen: string;
    meta: Record<string, unknown>;
}

export const AGENT_ROLES = [
    "memory",
    "research",
    "drafting",
    "evidence",
    "strategy",
    "style",
    "morning",
    "general",
] as const;
export type AgentRole = typeof AGENT_ROLES[number];

// ---- Trusted multi-agent coordination types ----

export const COORDINATION_PROVENANCE = [
	"user",
	"document",
	"agent",
	"inference",
] as const;
export type CoordinationProvenance =
	(typeof COORDINATION_PROVENANCE)[number];

export const COORDINATION_HANDOFF_STATES = [
	"draft",
	"submitted",
	"verified",
	"rejected",
	"expired",
] as const;
export type CoordinationHandoffState =
	(typeof COORDINATION_HANDOFF_STATES)[number];

export const COUNCIL_ROLES = [
	"evidence",
	"user_intent",
	"safety",
	"privacy",
	"strategy",
	"operations",
	"adversarial_review",
] as const;
export type CouncilRole = (typeof COUNCIL_ROLES)[number];

export const COUNCIL_VOTES = ["approve", "reject", "escalate"] as const;
export type CouncilVoteValue = (typeof COUNCIL_VOTES)[number];

export type CoordinationLeaseState =
	| "active"
	| "released"
	| "expired"
	| "completed"
	| "failed";

export type CoordinationTaskEventType =
	| "claimed"
	| "heartbeated"
	| "released"
	| "expired"
	| "completed"
	| "failed";

export type CouncilProposalStatus = "open" | "decided" | "expired";
export type CouncilOutcome =
	| "pending"
	| "approved"
	| "rejected"
	| "escalated";

export interface CoordinationHandoff {
	id: string;
	userId: string;
	from_agent: string;
	to_agent: string | null;
	target_role: string | null;
	summary: string;
	next_steps: string;
	evidence: string[];
	provenance: CoordinationProvenance;
	confidence: number;
	state: CoordinationHandoffState;
	expires_at: string | null;
	submitted_at: string | null;
	content_sha256: string;
	source_run_id: string | null;
	supersedes_id: string | null;
	actor_id: string;
	created_at: string;
	updated_at: string;
}

export interface CoordinationHandoffReview {
	id: string;
	userId: string;
	handoff_id: string;
	reviewer_id: string;
	decision: Extract<CoordinationHandoffState, "verified" | "rejected">;
	reason: string | null;
	evidence: string[];
	actor_id: string;
	created_at: string;
	updated_at: string;
}

export interface CoordinationLease {
	id: string;
	userId: string;
	task_id: string;
	lease_id: string;
	holder_id: string;
	state: CoordinationLeaseState;
	leased_at: string;
	heartbeat_at: string;
	expires_at: string;
	released_at: string | null;
	actor_id: string;
	created_at: string;
	updated_at: string;
}

export interface CouncilProposal {
	id: string;
	userId: string;
	question: string;
	options: string[];
	evidence_ids: string[];
	council_roles: CouncilRole[];
	status: CouncilProposalStatus;
	expires_at: string | null;
	actor_id: string;
	created_at: string;
	updated_at: string;
}

export interface CouncilVote {
	id: string;
	userId: string;
	proposal_id: string;
	council_role: CouncilRole;
	vote: CouncilVoteValue;
	reason: string;
	evidence_ids: string[];
	source_run_id: string | null;
	actor_id: string;
	created_at: string;
	updated_at: string;
}

export interface CouncilDecision {
	proposal: CouncilProposal;
	votes: CouncilVote[];
	outcome: CouncilOutcome;
	approve_count: number;
	reject_count: number;
	escalate_count: number;
	decided_at: string | null;
}

// ---- Trusted second-brain artifact types ----

export const ARTIFACT_KINDS = [
	"living_summary",
	"self_profile",
	"behavioral_profile",
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export const ARTIFACT_STATUSES = [
	"candidate",
	"published",
	"stale",
	"superseded",
	"rejected",
	"tombstoned",
] as const;
export type ArtifactStatus = (typeof ARTIFACT_STATUSES)[number];

export const ARTIFACT_FAILURE_CODES = [
	"no_eligible_evidence",
	"model_timeout",
	"invalid_model_output",
	"evidence_changed",
	"d1_failure",
	"generation_failed",
] as const;
export type ArtifactFailureCode = (typeof ARTIFACT_FAILURE_CODES)[number];

export const SELF_PROFILE_SECTIONS = [
	"identity",
	"personality",
	"psychology",
	"behavior",
	"history",
	"relationship",
	"preferences",
	"likes",
	"goals",
	"rules",
] as const;
export type SelfProfileSection = (typeof SELF_PROFILE_SECTIONS)[number];

export type ArtifactSourceKind =
	| "memory"
	| "profile_fact"
	| "behavioral_observation"
	| "personality_feedback";

export type ArtifactCitation = {
	source_kind: ArtifactSourceKind;
	source_id: string;
};

export type ArtifactClaim = {
	id: string;
	section: string;
	text: string;
	confidence: number;
	provenance: "stated" | "observed" | "inferred";
	sensitivity: "normal" | "sensitive";
	citations: ArtifactCitation[];
};

export type DerivedArtifact = {
	id: string;
	userId: string;
	kind: ArtifactKind;
	version: number;
	status: ArtifactStatus;
	validation_state: "validated" | "legacy_unverified";
	claims: ArtifactClaim[];
	rendered_text: string | null;
	source_watermark: string | null;
	evidence_generation: number;
	eligible_source_count: number;
	selected_source_count: number;
	source_truncated: boolean;
	content_sha256: string | null;
	model: string | null;
	prompt_version: string;
	validation: Record<string, unknown>;
	supersedes_id: string | null;
	created_at: string;
	published_at: string | null;
	reviewed_at: string | null;
	reviewed_by: string | null;
};

export type ArtifactEvidence = {
	kind: ArtifactSourceKind;
	id: string;
	text: string;
	sourceSha256: string;
	section: string;
	updatedAt: string;
	status:
		| "active"
		| "suppressed"
		| "rejected"
		| "superseded"
		| "tombstoned";
	sourceType: "stated" | "observed" | "inferred";
	verified: boolean;
	confidence: number;
	salience: number;
	pinned: boolean;
	core: boolean;
	observationType?: string;
};

export type ArtifactDraft = {
	kind: ArtifactKind;
	claims: ArtifactClaim[];
	renderedText: string;
	sourceWatermark: string;
	eligibleSourceCount: number;
	selectedSourceCount: number;
	sourceTruncated: boolean;
	contentSha256: string;
	model: string;
	promptVersion: string;
	validation: Record<string, unknown>;
	evidence: ArtifactEvidence[];
};

export type ArtifactRebuildState = {
	userId: string;
	kind: "living_summary";
	retry_count: number;
	next_retry_at: string | null;
	last_error_code: string | null;
	operation_id: string;
	updated_at: string;
};

export type ArtifactCachePurgeState = {
	userId: string;
	kind: ArtifactKind;
	artifact_id: string;
	operation_id: string;
	attempt_count: number;
	next_attempt_at: string | null;
	last_error_code: string | null;
	created_at: string;
	updated_at: string;
};

export type DerivedArtifactSource = {
	artifact_id: string;
	userId: string;
	claim_id: string;
	source_kind: ArtifactSourceKind;
	source_id: string;
	source_updated_at: string;
	source_sha256: string;
	citation_role: "supporting";
};

export type DerivedArtifactEvent = {
	id: string;
	userId: string;
	artifact_id: string | null;
	kind: ArtifactKind;
	event_type: string;
	reason_code: string | null;
	actor: string;
	source_watermark: string | null;
	metadata: Record<string, unknown>;
	created_at: string;
};

export type DerivedArtifactDetail = {
	artifact: DerivedArtifact;
	sources: DerivedArtifactSource[];
	events: DerivedArtifactEvent[];
};

export type ProfileFact = {
	id: string;
	userId: string;
	section: SelfProfileSection;
	field: string;
	value: string | null;
	confidence: number;
	source_type: "stated";
	source_id: string | null;
	status: "active" | "superseded" | "tombstoned";
	supersedes_id: string | null;
	verified_at: string;
	created_at: string;
	updated_at: string;
};
