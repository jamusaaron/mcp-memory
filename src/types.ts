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

export const AGENT_ROLES = ["prompt"] as const;
export type AgentRole = typeof AGENT_ROLES[number];

export interface AgentRun {
	id: string;
	userId: string;
	role: string;
	input: string;
	output: string;
	memory_ids: string[];
	created_at: string;
}


