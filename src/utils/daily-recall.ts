import type { Memory } from "../types";

export type DecisionInput = {
	decision: string;
	rationale?: string;
	project?: string;
	alternatives?: string[];
	decidedAt?: string;
	tags?: string[];
};

export type DecisionRecord = {
	text: string;
	subject: string;
	tags: string[];
	decidedAt: string;
};

export type DecisionView = {
	id: string;
	decision: string;
	project?: string;
	decided_at: string;
	rationale?: string;
	alternatives: string[];
	relevance?: number;
};

export type MemoryChange = {
	id: string;
	changeType: "created" | "updated";
	changedAt: string;
	category: string;
	subject?: string;
	text: string;
};

export type DigestCandidate = {
	memory: Memory;
	relevance: number;
};

export type DigestSource = {
	id: string;
	createdAt: string;
	category: string;
	text: string;
	relevance: number;
};

export function parseIsoTimestamp(value: string, field: string): string {
	const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
	if (!match) throw new Error(`${field} must be a valid ISO timestamp`);
	const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
	const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	if (
		month < 1 ||
		month > 12 ||
		day < 1 ||
		day > daysInMonth[month - 1] ||
		hour > 23 ||
		minute > 59 ||
		second > 59
	) {
		throw new Error(`${field} must be a valid ISO timestamp`);
	}
	const date = new Date(value);
	if (!Number.isFinite(date.getTime())) throw new Error(`${field} must be a valid ISO timestamp`);
	return date.toISOString();
}

export function projectTag(project: string): string {
	const slug = project
		.normalize("NFKD")
		.replace(/[^\w\s-]/g, "")
		.trim()
		.toLowerCase()
		.replace(/[\s_]+/g, "-")
		.replace(/-+/g, "-");
	if (!slug) throw new Error("project must contain at least one letter or number");
	return `project:${slug}`;
}

function cleanTags(tags: string[]): string[] {
	return [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
}

function boundedLimit(value: number): number {
	if (!Number.isFinite(value) || value <= 0) return 0;
	return Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER);
}

function citationId(id: string): string {
	return encodeURIComponent(id);
}

function escapeDigestText(text: string): string {
	return text.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

export function buildDecisionRecord(input: DecisionInput, now: string): DecisionRecord {
	const decidedAt = parseIsoTimestamp(input.decidedAt ?? now, "decided_at");
	const decision = input.decision.trim();
	if (!decision) throw new Error("decision must not be empty");
	const alternatives = (input.alternatives ?? []).map((value) => value.trim()).filter(Boolean);
	const tags = cleanTags([
		"decision",
		...(input.project ? [projectTag(input.project)] : []),
		...(input.tags ?? []),
	]);
	const lines = [`Decision: ${decision}`, `Decided: ${decidedAt}`];
	if (input.project?.trim()) lines.push(`Project: ${input.project.trim()}`);
	if (input.rationale?.trim()) lines.push(`Rationale: ${input.rationale.trim()}`);
	if (alternatives.length) lines.push(`Alternatives:\n${alternatives.map((item) => `- ${item}`).join("\n")}`);
	return {
		text: lines.join("\n"),
		subject: decision.split(/\s+/).slice(0, 10).join(" "),
		tags,
		decidedAt,
	};
}

function field(text: string, name: string): string | undefined {
	return text.match(new RegExp(`^${name}:\\s*(.+)$`, "mi"))?.[1]?.trim();
}

export function parseDecisionMemory(memory: Memory, relevance?: number): DecisionView | null {
	if (!memory.tags.includes("decision")) return null;
	const decision = field(memory.text, "Decision");
	if (!decision) return null;
	const alternativesBlock = memory.text.match(/^Alternatives:\s*\n((?:- .+(?:\n|$))*)/mi)?.[1] ?? "";
	return {
		id: memory.id,
		decision,
		...(field(memory.text, "Project") ? { project: field(memory.text, "Project") } : {}),
		decided_at: parseIsoTimestamp(field(memory.text, "Decided") ?? memory.created_at, "decided_at"),
		...(field(memory.text, "Rationale")
			? { rationale: field(memory.text, "Rationale") }
			: {}),
		alternatives: alternativesBlock
			.split("\n")
			.map((line) => line.replace(/^- /, "").trim())
			.filter(Boolean),
		...(relevance === undefined ? {} : { relevance }),
	};
}

export function classifyMemoryChanges(
	memories: Memory[],
	since: string,
	categories?: string[],
	limit = 100,
): MemoryChange[] {
	const threshold = parseIsoTimestamp(since, "since");
	return memories
		.filter((memory) => !memory.suppressed)
		.filter((memory) => !categories?.length || categories.includes(memory.category))
		.map((memory) => {
			const createdAt = parseIsoTimestamp(memory.created_at, "created_at");
			const updatedAt = parseIsoTimestamp(memory.updated_at, "updated_at");
			const createdSinceThreshold = createdAt >= threshold;
			return {
				id: memory.id,
				changeType: createdSinceThreshold ? ("created" as const) : ("updated" as const),
				changedAt: createdSinceThreshold ? createdAt : updatedAt,
				category: memory.category,
				...(memory.subject ? { subject: memory.subject } : {}),
				text: memory.text,
			};
		})
		.filter((change) => change.changedAt >= threshold)
		.sort((a, b) => b.changedAt.localeCompare(a.changedAt))
		.slice(0, boundedLimit(limit));
}

export function rankDigestSources(
	candidates: DigestCandidate[],
	now: string,
	maxSources: number,
): DigestSource[] {
	const nowMs = new Date(parseIsoTimestamp(now, "now")).getTime();
	return candidates
		.map(({ memory, relevance }) => {
			const createdAt = parseIsoTimestamp(memory.created_at, "created_at");
			const updatedAt = parseIsoTimestamp(memory.updated_at, "updated_at");
			const effectiveAt = parseIsoTimestamp(updatedAt > createdAt ? updatedAt : createdAt, "effective_at");
			const ageDays = Math.max(0, (nowMs - new Date(effectiveAt).getTime()) / 86_400_000);
			const recency = 1 / (1 + ageDays / 30);
			const score = relevance * 0.7 + memory.salience * 0.2 + recency * 0.1;
			return {
				source: {
					id: memory.id,
					createdAt,
					category: memory.category,
					text: memory.text,
					relevance: Number(relevance.toFixed(4)),
				},
				score,
			};
		})
		.sort((a, b) => b.score - a.score || b.source.createdAt.localeCompare(a.source.createdAt) || a.source.id.localeCompare(b.source.id))
		.slice(0, boundedLimit(maxSources))
		.map(({ source }) => source);
}

export function renderExtractiveDigest(_topic: string, sources: DigestSource[]): string {
	return sources.map((source) => `- [${citationId(source.id)}] ${escapeDigestText(source.text)}`).join("\n");
}

export function digestHasValidCitations(digest: string, sources: DigestSource[]): boolean {
	if (!digest.trim() || sources.length === 0) return false;
	const known = new Set(sources.map((source) => citationId(source.id)));
	const citations = [...digest.matchAll(/(?<!\\)\[([^\]]*)\]/g)].map((match) => match[1]);
	return citations.length > 0 && citations.every((id) => known.has(id));
}
