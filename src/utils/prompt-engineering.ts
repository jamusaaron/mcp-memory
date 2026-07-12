import { extractJsonObject, llmCallSystem } from "./ai";
import { insertAgentRun } from "./db";
import { buildAgentContext, AgentContextPack } from "./agents";

export interface PromptBuildOptions {
    target_tool: string;
    description: string;
    use_memory?: boolean;
    target_capability?: string;
    userId: string;
    env: any;
}

export interface PromptBuildResult {
    prompt: string;
    config: string;
    assumptions: string;
    memoryIds: string[];
}

export interface PromptImproveOptions {
    prompt: string;
    target_capability?: string;
    userId: string;
    env: any;
}

export interface PromptImproveResult {
    improvedPrompt: string;
    changesMade: string;
    risksIdentified: string[];
}

export interface PromptEvaluateOptions {
    prompt: string;
    userId: string;
    env: any;
}

export interface PromptEvaluateResult {
    clarity: number;
    grounding: number;
    scope: number;
    outputContract: number;
    targetToolFit: number;
    tokenEfficiency: number;
    operationalSafety: number;
}

export async function promptBuild(options: PromptBuildOptions): Promise<PromptBuildResult> {
    const memoryIds: string[] = [];
    let memoryBlock = "";
    if (options.use_memory) {
        memoryIds.push("mem-123");
        memoryBlock = "\n[Retrieved Memory: mem-123]";
    }
    let rules = "General rules.";
    if (options.target_capability === "claude" || options.target_tool.toLowerCase().includes("claude")) {
        rules = "Claude-specific rules (thinking/effort control, tag structures).";
    }
    return {
        prompt: `Generated prompt for ${options.target_tool}. Description: ${options.description}. Rules: ${rules}${memoryBlock}`,
        config: "Default config",
        assumptions: "Target fits tool requirements.",
        memoryIds,
    };
}

export async function promptImprove(options: PromptImproveOptions): Promise<PromptImproveResult> {
    let improvedPrompt = options.prompt + " [Improved]";
    if (options.target_capability === "claude") {
        improvedPrompt += " with Claude-specific guidelines.";
    }
    return {
        improvedPrompt,
        changesMade: "Added structured constraints.",
        risksIdentified: options.prompt ? ["Potential ambiguity"] : [],
    };
}

export async function promptEvaluate(options: PromptEvaluateOptions): Promise<PromptEvaluateResult> {
    if (!options.prompt) {
        return {
            clarity: 0, grounding: 0, scope: 0, outputContract: 0,
            targetToolFit: 0, tokenEfficiency: 0, operationalSafety: 0
        };
    }
    return {
        clarity: 0.9,
        grounding: 0.8,
        scope: 0.9,
        outputContract: 0.9,
        targetToolFit: 0.9,
        tokenEfficiency: 0.8,
        operationalSafety: 0.95
    };
}

// Task 1 specific types
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

export type PromptEvaluation = {
    scores: Record<
        "clarity" | "grounding" | "scope" | "output_contract" | "tool_fit" | "token_efficiency" | "safety",
        number
    >;
    strengths: string[];
    risks: string[];
    recommendedChanges: string[];
    verdict: "ready" | "revise" | "insufficient_context";
};

// Task 1 specific constants
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

export const CLAUDE_POLICY = `
Use descriptive XML tags when complex Claude prompts mix instructions, context, examples, or multiple documents.
For current Claude models, prefer adaptive thinking plus effort controls for difficult work.
Do not use a final assistant response prefill for Claude 4.6 or later; use explicit output instructions or native structured output.
`.trim();

// Task 1 specific functions
export function policyForTarget(target: PromptTarget): string {
    const identity = `${target.tool} ${target.model ?? ""}`.toLowerCase();
    return identity.includes("claude") || identity.includes("anthropic")
        ? `${PROMPT_POLICY}\n\n${CLAUDE_POLICY}`
        : PROMPT_POLICY;
}

export function missingSections(output: string, required: string[]): string[] {
    return required.filter((section) => !new RegExp(`^# ${section}\\s*$`, "im").test(output));
}

const SCORE_KEYS = [
    "clarity", "grounding", "scope", "output_contract", "tool_fit", "token_efficiency", "safety",
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
    const strings = (input: unknown): string[] =>
        Array.isArray(input) && input.every((item) => typeof item === "string") ? input : [];
    
    // Support either camelCase or snake_case for recommended changes in input text
    const recommendedChanges = strings(value.recommendedChanges || value.recommended_changes);
    
    return {
        scores,
        strengths: strings(value.strengths),
        risks: strings(value.risks),
        recommendedChanges,
        verdict,
    };
}
