import { type AgentContextPack, buildAgentContext } from "./agents";
import { extractJsonObject, llmCallSystem } from "./ai";
import { insertAgentRun } from "./db";

export type PromptTarget = {
	tool: string;
	model?: string;
	mode?: "chat" | "api" | "agent" | "ide" | "image" | "video" | "voice" | "workflow";
};

export type PromptBuildRequest = {
	objective: string;
	target: PromptTarget;
	outputRequirements?: string;
	constraints?: string[];
	inputDescription?: string;
	useMemory: boolean;
};

export type PromptImprovementRequest = {
	prompt: string;
	target: PromptTarget;
	knownFailure?: string;
	preserve?: string[];
	useMemory: boolean;
};

export type PromptRuntimeDependencies = {
	buildContext: typeof buildAgentContext;
	callModel: typeof llmCallSystem;
	logRun: typeof insertAgentRun;
};

const DEFAULT_DEPS: PromptRuntimeDependencies = {
	buildContext: buildAgentContext,
	callModel: llmCallSystem,
	logRun: insertAgentRun,
};

export type PromptOperationResult = {
	output: string;
	runId: string;
	memoryIds: string[];
	memoryAvailable: boolean;
};

export type PromptEvaluation = {
	scores: Record<
		| "clarity"
		| "grounding"
		| "scope"
		| "output_contract"
		| "tool_fit"
		| "token_efficiency"
		| "safety",
		number
	>;
	strengths: string[];
	risks: string[];
	recommendedChanges: string[];
	verdict: "ready" | "revise" | "insufficient_context";
};

export const PROMPT_POLICY = `
Establish the objective, success criteria, target capability, output contract, and hard constraints before adding technique.
Use aligned examples when boundary behaviour or format is easier to show than describe.
Prefer native structured output or tool calling over prose-only JSON requests.
For long-context Claude tasks, place source material before the query and keep the task near the end.
Use adaptive thinking or an effort control where supported; never require exposed private chain-of-thought.
Prompt chaining is valid when intermediate verification or context separation improves reliability.
Name tools when action is expected, but do not mandate tools or subagents when direct work is simpler.
Bound agents with scope, authority, stop conditions, verification, and a concrete done-state.
Avoid over-engineering: do not add unrelated features, abstractions, files, or refactors.
Treat model names and parameter availability as time-sensitive; state uncertainty rather than guessing.
Keep memory-derived context separate from user-supplied facts and identify the memory IDs used.
`.trim();

const CLAUDE_POLICY = `
Use descriptive XML tags when complex Claude prompts mix instructions, context, examples, or multiple documents.
For current Claude models, prefer adaptive thinking plus effort controls for difficult work.
Do not use a final assistant response prefill for Claude 4.6 or later; use explicit output instructions or native structured output.
`.trim();

export function policyForTarget(target: PromptTarget): string {
	const identity = `${target.tool} ${target.model ?? ""}`.toLowerCase();
	return identity.includes("claude") || identity.includes("anthropic")
		? `${PROMPT_POLICY}\n\n${CLAUDE_POLICY}`
		: PROMPT_POLICY;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function missingSections(output: string, required: string[]): string[] {
	return required.filter(
		(section) => !new RegExp(`^# ${escapeRegExp(section)}\\s*$`, "im").test(output),
	);
}

const SCORE_KEYS = [
	"clarity",
	"grounding",
	"scope",
	"output_contract",
	"tool_fit",
	"token_efficiency",
	"safety",
] as const;

export function parsePromptEvaluation(text: string): PromptEvaluation {
	const value = extractJsonObject<Record<string, unknown>>(text);
	if (!value || typeof value.scores !== "object" || value.scores === null) {
		throw new Error("Prompt evaluation is not valid JSON with scores");
	}
	const rawScores = value.scores as Record<string, unknown>;
	const scores = {} as PromptEvaluation["scores"];
	for (const key of SCORE_KEYS) {
		const score = rawScores[key];
		if (typeof score !== "number" || score < 0 || score > 100) {
			throw new Error(`${key} score must be between 0 and 100`);
		}
		scores[key] = score;
	}
	const verdict = value.verdict;
	if (verdict !== "ready" && verdict !== "revise" && verdict !== "insufficient_context") {
		throw new Error("Prompt evaluation verdict is invalid");
	}
	const strings = (field: string, input: unknown): string[] => {
		if (!Array.isArray(input) || !input.every((item) => typeof item === "string")) {
			throw new Error(`${field} must be an array of strings`);
		}
		return input;
	};
	return {
		scores,
		strengths: strings("strengths", value.strengths),
		risks: strings("risks", value.risks),
		recommendedChanges: strings("recommended_changes", value.recommended_changes),
		verdict,
	};
}

function formatPromptMemory(ctx: AgentContextPack): string {
	const lines = [
		ctx.summary ? `Summary: ${ctx.summary}` : "",
		...ctx.pinned.map((item) => `[${item.id}] ${item.text}`),
		...ctx.related.slice(0, 8).map((item) => `[${item.id}] ${item.text}`),
	].filter(Boolean);
	return lines.length ? `<memory_context>\n${lines.join("\n")}\n</memory_context>` : "";
}

async function optionalContext(
	userId: string,
	query: string,
	useMemory: boolean,
	env: Env,
	deps: PromptRuntimeDependencies,
): Promise<{ block: string; ids: string[]; available: boolean }> {
	if (!useMemory) return { block: "", ids: [], available: true };
	try {
		const ctx = await deps.buildContext(userId, query, env);
		return { block: formatPromptMemory(ctx), ids: ctx.memoryIds, available: true };
	} catch {
		return { block: "", ids: [], available: false };
	}
}

async function generateSections(
	system: string,
	user: string,
	required: string[],
	env: Env,
	deps: PromptRuntimeDependencies,
): Promise<string> {
	const first = await deps.callModel(system, user, env, 2200);
	const missing = missingSections(first, required);
	if (missing.length === 0) return first;
	const repaired = await deps.callModel(
		system,
		`Repair the response below. Return the complete response with these missing sections: ${missing.join(
			", ",
		)}\n\n${first}`,
		env,
		2200,
	);
	const stillMissing = missingSections(repaired, required);
	if (stillMissing.length) {
		throw new Error(`Prompt output missing sections after repair: ${stillMissing.join(", ")}`);
	}
	return repaired;
}

export async function buildPrompt(
	userId: string,
	request: PromptBuildRequest,
	env: Env,
	deps: PromptRuntimeDependencies = DEFAULT_DEPS,
): Promise<PromptOperationResult> {
	const memory = await optionalContext(userId, request.objective, request.useMemory, env, deps);
	const system = `${policyForTarget(
		request.target,
	)}\n\nBuild one production-ready prompt. Required headings: Prompt, Configuration, Assumptions, Quality check.`;
	const user = `${memory.block}\n\nTarget: ${JSON.stringify(request.target)}\nObjective: ${
		request.objective
	}\nOutput requirements: ${request.outputRequirements ?? "not supplied"}\nConstraints: ${
		(request.constraints ?? []).join("; ") || "none supplied"
	}\nInput description: ${request.inputDescription ?? "not supplied"}\nMemory available: ${
		memory.available
	}`;
	const output = await generateSections(
		system,
		user,
		["Prompt", "Configuration", "Assumptions", "Quality check"],
		env,
		deps,
	);
	const runId = await deps.logRun(
		userId,
		"prompt",
		JSON.stringify(request),
		output,
		memory.ids,
		env,
	);
	return {
		output,
		runId,
		memoryIds: memory.ids,
		memoryAvailable: memory.available,
	};
}

export async function improvePrompt(
	userId: string,
	request: PromptImprovementRequest,
	env: Env,
	deps: PromptRuntimeDependencies = DEFAULT_DEPS,
): Promise<PromptOperationResult> {
	const query = request.knownFailure
		? `${request.knownFailure}\n${request.prompt}`
		: request.prompt;
	const memory = await optionalContext(userId, query, request.useMemory, env, deps);
	const system = `${policyForTarget(
		request.target,
	)}\n\nDiagnose and replace the supplied prompt without changing its objective or hard constraints. Required headings: Diagnosis, Improved prompt, Material changes, Assumptions.`;
	const user = `${memory.block}\n\nTarget: ${JSON.stringify(request.target)}\nKnown failure: ${
		request.knownFailure ?? "not supplied"
	}\nPreserve exactly: ${
		(request.preserve ?? []).join("; ") || "the stated objective and hard constraints"
	}\n\nOriginal prompt:\n${request.prompt}\n\nMemory available: ${memory.available}`;
	const output = await generateSections(
		system,
		user,
		["Diagnosis", "Improved prompt", "Material changes", "Assumptions"],
		env,
		deps,
	);
	const runId = await deps.logRun(
		userId,
		"prompt",
		JSON.stringify(request),
		output,
		memory.ids,
		env,
	);
	return {
		output,
		runId,
		memoryIds: memory.ids,
		memoryAvailable: memory.available,
	};
}

export type PromptEvaluationResult = {
	evaluation: PromptEvaluation;
	runId: string;
};

export async function evaluatePrompt(
	userId: string,
	prompt: string,
	target: PromptTarget,
	intendedOutcome: string | undefined,
	env: Env,
	deps: PromptRuntimeDependencies = DEFAULT_DEPS,
): Promise<PromptEvaluationResult> {
	const system = `${policyForTarget(
		target,
	)}\n\nEvaluate the prompt. Return JSON only with scores for clarity, grounding, scope, output_contract, tool_fit, token_efficiency, and safety (0-100); string arrays strengths, risks, and recommended_changes; and verdict ready, revise, or insufficient_context.`;
	const user = `Target: ${JSON.stringify(target)}\nIntended outcome: ${
		intendedOutcome ?? "not supplied"
	}\n\nPrompt to evaluate:\n${prompt}`;
	const first = await deps.callModel(system, user, env, 1800);
	let evaluation: PromptEvaluation;
	try {
		evaluation = parsePromptEvaluation(first);
	} catch (error) {
		const repaired = await deps.callModel(
			system,
			`Repair this evaluation JSON so it satisfies the required schema and every score is between 0 and 100.\nError: ${String(
				error,
			)}\n\n${first}`,
			env,
			1800,
		);
		evaluation = parsePromptEvaluation(repaired);
	}
	const output = JSON.stringify(evaluation);
	const runId = await deps.logRun(userId, "prompt-evaluate", prompt, output, [], env);
	return { evaluation, runId };
}
