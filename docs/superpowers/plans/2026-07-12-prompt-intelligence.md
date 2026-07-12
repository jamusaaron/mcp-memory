# MCP Memory Prompt Intelligence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three memory-aware prompt-engineering MCP tools—`prompt_build`, `prompt_improve`, and `prompt_evaluate`—plus a reusable `prompt` agent role.

**Architecture:** Add a focused prompt-policy and runtime module that reuses `buildAgentContext`, `llmCallSystem`, and `insertAgentRun`. Keep policy selection and output validation pure and unit-testable; inject runtime dependencies for memory/model/database tests. Register a thin MCP tool layer and preserve every existing tool, binding, and database table.

**Tech Stack:** TypeScript, Node test runner, Zod, MCP TypeScript SDK, Cloudflare Workers AI, D1-backed agent-run audit, existing hybrid memory retrieval.

## Global Constraints

- Preserve all existing uncommitted orchestration, R2/KV, schema, and model-migration work.
- Add no D1 migration, Cloudflare binding, dependency, prompt-version table, or automatic prompt storage.
- Keep target routing capability-based; treat named models and parameter availability as time-sensitive.
- Use retrieved memory only when `use_memory` is true, label it separately, and return the memory IDs used.
- Perform at most one repair model call after malformed output.
- Do not recommend final-assistant-message prefilling for Claude 4.6 or later.
- Do not prohibit prompt chaining when intermediate verification or context separation improves reliability.
- Update the MCP surface from 135 to exactly 138 tools.
- Run `npm run test:all` before any deployment attempt.
- Deploy only when `CLOUDFLARE_API_TOKEN` is present.

---

## File map

- Create `src/utils/prompt-engineering.ts`: request/result types, durable policy, target routing, memory formatting, validation, repair, runtime orchestration, and audit logging.
- Create `src/tools/prompt-engineering.ts`: Zod schemas and three thin MCP registrations.
- Create `tests/prompt-engineering.test.ts`: policy, routing, memory opt-out/fallback, repair ceiling, score validation, and audit tests.
- Create `tests/prompt-tool-surface.test.ts`: source-level registration and role wiring assertions.
- Modify `src/types.ts`: add `prompt` to `AGENT_ROLES`.
- Modify `src/utils/agents.ts`: add the `prompt` role system contract.
- Modify `src/mcp.ts`: import and register `registerPromptEngineeringTools`.
- Modify `scripts/check-tool-surface.mjs`: include the new tool file, assert registration in `src/mcp.ts`, and set `EXPECTED_TOOLS` to 138.
- Create `docs/superpowers/evals/prompt-intelligence/README.md`: record the five behaviour-evaluation cases and observed comparison results.

---

### Task 1: Durable prompt policy and pure validators

**Files:**
- Create: `tests/prompt-engineering.test.ts`
- Create: `src/utils/prompt-engineering.ts`

**Interfaces:**
- Produces: `PromptTarget`, `PromptBuildRequest`, `PromptImprovementRequest`, `PromptEvaluation`, `PROMPT_POLICY`, `policyForTarget`, `missingSections`, and `parsePromptEvaluation`.
- Consumes: no database or Cloudflare runtime in this task.

- [ ] **Step 1: Write failing policy and parser tests**

Create `tests/prompt-engineering.test.ts` with these initial tests:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import {
	PROMPT_POLICY,
	missingSections,
	parsePromptEvaluation,
	policyForTarget,
} from "../src/utils/prompt-engineering";

test("prompt policy encodes current durable guidance", () => {
	assert.match(PROMPT_POLICY, /native structured output/i);
	assert.match(PROMPT_POLICY, /adaptive thinking|effort control/i);
	assert.match(PROMPT_POLICY, /source material before the query/i);
	assert.match(PROMPT_POLICY, /over-engineer/i);
	assert.match(PROMPT_POLICY, /prompt chaining/i);
	assert.doesNotMatch(PROMPT_POLICY, /never use prompt chaining/i);
	assert.doesNotMatch(PROMPT_POLICY, /prefill the final assistant/i);
});

test("Claude routing adds current Claude-specific constraints", () => {
	const policy = policyForTarget({ tool: "Claude API", model: "Claude 4.6", mode: "api" });
	assert.match(policy, /XML/i);
	assert.match(policy, /final assistant.*prefill/i);
	assert.match(policy, /adaptive thinking/i);
});

test("section validation reports only missing required sections", () => {
	const output = "# Prompt\nDo the task.\n\n# Configuration\nNone.";
	assert.deepEqual(missingSections(output, ["Prompt", "Configuration", "Assumptions"]), [
		"Assumptions",
	]);
});

test("evaluation parser validates all seven scores", () => {
	const parsed = parsePromptEvaluation(JSON.stringify({
		scores: {
			clarity: 90,
			grounding: 80,
			scope: 70,
			output_contract: 60,
			tool_fit: 50,
			token_efficiency: 40,
			safety: 100,
		},
		strengths: ["Clear objective"],
		risks: [],
		recommended_changes: ["Specify length"],
		verdict: "revise",
	}));
	assert.equal(parsed.scores.safety, 100);
	assert.throws(
		() => parsePromptEvaluation(JSON.stringify({ ...parsed, scores: { ...parsed.scores, clarity: 101 } })),
		/clarity.*0 and 100/i,
	);
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```bash
node --import tsx --test tests/prompt-engineering.test.ts
```

Expected: FAIL with `Cannot find module '../src/utils/prompt-engineering'`.

- [ ] **Step 3: Implement the minimal policy, types, routing, and parsers**

Create `src/utils/prompt-engineering.ts` with:

```ts
import { extractJsonObject, llmCallSystem } from "./ai";
import { buildAgentContext, type AgentContextPack } from "./agents";
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
	return {
		scores,
		strengths: strings(value.strengths),
		risks: strings(value.risks),
		recommendedChanges: strings(value.recommended_changes),
		verdict,
	};
}
```

- [ ] **Step 4: Run the focused test and confirm GREEN**

Run:

```bash
node --import tsx --test tests/prompt-engineering.test.ts
```

Expected: 4 tests pass, 0 fail.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/utils/prompt-engineering.ts tests/prompt-engineering.test.ts
git commit -m "feat: add durable prompt engineering policy"
```

---

### Task 2: Memory-aware runtime, repair ceiling, and audit logging

**Files:**
- Modify: `src/utils/prompt-engineering.ts`
- Modify: `tests/prompt-engineering.test.ts`

**Interfaces:**
- Produces: `buildPrompt`, `improvePrompt`, `evaluatePrompt`, `PromptOperationResult`, and injectable `PromptRuntimeDependencies`.
- Consumes: `buildAgentContext`, `llmCallSystem`, and `insertAgentRun`.

- [ ] **Step 1: Add failing runtime tests**

Append tests using injected dependencies:

```ts
import {
	buildPrompt,
	evaluatePrompt,
	improvePrompt,
	type PromptRuntimeDependencies,
} from "../src/utils/prompt-engineering";

function runtimeHarness(outputs: string[]) {
	const calls: string[] = [];
	const logged: Array<{ role: string; memoryIds: string[] }> = [];
	const deps: PromptRuntimeDependencies = {
		buildContext: async () => ({
			summary: "Jamie prefers Australian English.",
			selfProfile: null,
			contextCurrent: null,
			pinned: [{ id: "m1", text: "Use Australian English", category: "preferences" }],
			related: [],
			highSalience: [],
			memoryIds: ["m1"],
		}),
		callModel: async (_system, user) => {
			calls.push(user);
			return outputs.shift() ?? "";
		},
		logRun: async (_userId, role, _input, _output, memoryIds) => {
			logged.push({ role, memoryIds });
			return "run-1";
		},
	};
	return { deps, calls, logged };
}

test("prompt build uses memory and logs provenance", async () => {
	const { deps, calls, logged } = runtimeHarness([
		"# Prompt\nWrite it.\n# Configuration\nNone.\n# Assumptions\nUses m1.\n# Quality check\nPass.",
	]);
	const result = await buildPrompt("user", {
		objective: "Draft a note",
		target: { tool: "Claude" },
		useMemory: true,
	}, {} as Env, deps);
	assert.deepEqual(result.memoryIds, ["m1"]);
	assert.match(calls[0] ?? "", /Use Australian English/);
	assert.deepEqual(logged, [{ role: "prompt", memoryIds: ["m1"] }]);
});

test("prompt build opt-out avoids memory retrieval", async () => {
	let contextCalls = 0;
	const { deps } = runtimeHarness([
		"# Prompt\nDo it.\n# Configuration\nNone.\n# Assumptions\nNone.\n# Quality check\nPass.",
	]);
	deps.buildContext = async () => {
		contextCalls += 1;
		throw new Error("must not run");
	};
	await buildPrompt("user", {
		objective: "Do it",
		target: { tool: "Generic chat" },
		useMemory: false,
	}, {} as Env, deps);
	assert.equal(contextCalls, 0);
});

test("malformed build output receives exactly one repair call", async () => {
	const { deps, calls } = runtimeHarness([
		"# Prompt\nIncomplete",
		"# Prompt\nFixed.\n# Configuration\nNone.\n# Assumptions\nNone.\n# Quality check\nPass.",
	]);
	await buildPrompt("user", {
		objective: "Do it",
		target: { tool: "Claude" },
		useMemory: false,
	}, {} as Env, deps);
	assert.equal(calls.length, 2);
});

test("evaluation repairs invalid scores once", async () => {
	const valid = JSON.stringify({
		scores: { clarity: 80, grounding: 80, scope: 80, output_contract: 80, tool_fit: 80, token_efficiency: 80, safety: 80 },
		strengths: [], risks: [], recommended_changes: [], verdict: "ready",
	});
	const { deps, calls } = runtimeHarness([
		JSON.stringify({ scores: { clarity: 101 }, verdict: "ready" }),
		valid,
	]);
	const result = await evaluatePrompt("user", "Do it", { tool: "Claude" }, undefined, {} as Env, deps);
	assert.equal(result.evaluation.verdict, "ready");
	assert.equal(calls.length, 2);
});
```

- [ ] **Step 2: Run focused tests and confirm RED**

Run:

```bash
node --import tsx --test tests/prompt-engineering.test.ts
```

Expected: FAIL because runtime exports do not exist.

- [ ] **Step 3: Implement runtime dependencies and memory formatting**

Add to `src/utils/prompt-engineering.ts`:

```ts
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
		`Repair the response below. Return the complete response with these missing sections: ${missing.join(", ")}\n\n${first}`,
		env,
		2200,
	);
	const stillMissing = missingSections(repaired, required);
	if (stillMissing.length) throw new Error(`Prompt output missing sections after repair: ${stillMissing.join(", ")}`);
	return repaired;
}
```

- [ ] **Step 4: Implement build, improve, and evaluate orchestration**

Add operation-specific functions that:

```ts
export async function buildPrompt(
	userId: string,
	request: PromptBuildRequest,
	env: Env,
	deps: PromptRuntimeDependencies = DEFAULT_DEPS,
): Promise<PromptOperationResult> {
	const memory = await optionalContext(userId, request.objective, request.useMemory, env, deps);
	const system = `${policyForTarget(request.target)}\n\nBuild one production-ready prompt. Required headings: Prompt, Configuration, Assumptions, Quality check.`;
	const user = `${memory.block}\n\nTarget: ${JSON.stringify(request.target)}\nObjective: ${request.objective}\nOutput requirements: ${request.outputRequirements ?? "not supplied"}\nConstraints: ${(request.constraints ?? []).join("; ") || "none supplied"}\nInput description: ${request.inputDescription ?? "not supplied"}\nMemory available: ${memory.available}`;
	const output = await generateSections(system, user, ["Prompt", "Configuration", "Assumptions", "Quality check"], env, deps);
	const runId = await deps.logRun(userId, "prompt", JSON.stringify(request), output, memory.ids, env);
	return { output, runId, memoryIds: memory.ids, memoryAvailable: memory.available };
}
```

Add the remaining operation functions:

```ts
export async function improvePrompt(
	userId: string,
	request: PromptImprovementRequest,
	env: Env,
	deps: PromptRuntimeDependencies = DEFAULT_DEPS,
): Promise<PromptOperationResult> {
	const query = request.knownFailure ? `${request.knownFailure}\n${request.prompt}` : request.prompt;
	const memory = await optionalContext(userId, query, request.useMemory, env, deps);
	const system = `${policyForTarget(request.target)}\n\nDiagnose and replace the supplied prompt without changing its objective or hard constraints. Required headings: Diagnosis, Improved prompt, Material changes, Assumptions.`;
	const user = `${memory.block}\n\nTarget: ${JSON.stringify(request.target)}\nKnown failure: ${request.knownFailure ?? "not supplied"}\nPreserve exactly: ${(request.preserve ?? []).join("; ") || "the stated objective and hard constraints"}\n\nOriginal prompt:\n${request.prompt}\n\nMemory available: ${memory.available}`;
	const output = await generateSections(
		system,
		user,
		["Diagnosis", "Improved prompt", "Material changes", "Assumptions"],
		env,
		deps,
	);
	const runId = await deps.logRun(userId, "prompt", JSON.stringify(request), output, memory.ids, env);
	return { output, runId, memoryIds: memory.ids, memoryAvailable: memory.available };
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
	const system = `${policyForTarget(target)}\n\nEvaluate the prompt. Return JSON only with scores for clarity, grounding, scope, output_contract, tool_fit, token_efficiency, and safety (0-100); string arrays strengths, risks, and recommended_changes; and verdict ready, revise, or insufficient_context.`;
	const user = `Target: ${JSON.stringify(target)}\nIntended outcome: ${intendedOutcome ?? "not supplied"}\n\nPrompt to evaluate:\n${prompt}`;
	const first = await deps.callModel(system, user, env, 1800);
	let evaluation: PromptEvaluation;
	try {
		evaluation = parsePromptEvaluation(first);
	} catch (error) {
		const repaired = await deps.callModel(
			system,
			`Repair this evaluation JSON so it satisfies the required schema and every score is between 0 and 100.\nError: ${String(error)}\n\n${first}`,
			env,
			1800,
		);
		evaluation = parsePromptEvaluation(repaired);
	}
	const output = JSON.stringify(evaluation);
	const runId = await deps.logRun(userId, "prompt-evaluate", prompt, output, [], env);
	return { evaluation, runId };
}
```

- [ ] **Step 5: Run focused tests and confirm GREEN**

```bash
node --import tsx --test tests/prompt-engineering.test.ts
```

Expected: 8 tests pass, 0 fail.

- [ ] **Step 6: Commit Task 2**

```bash
git add src/utils/prompt-engineering.ts tests/prompt-engineering.test.ts
git commit -m "feat: add memory-aware prompt runtime"
```

---

### Task 3: MCP tool contracts and registration

**Files:**
- Create: `src/tools/prompt-engineering.ts`
- Create: `tests/prompt-tool-surface.test.ts`
- Modify: `src/mcp.ts`
- Modify: `scripts/check-tool-surface.mjs`

**Interfaces:**
- Consumes: `buildPrompt`, `improvePrompt`, and `evaluatePrompt`.
- Produces: MCP tools `prompt_build`, `prompt_improve`, and `prompt_evaluate`.

- [ ] **Step 1: Write failing source-contract tests**

Create `tests/prompt-tool-surface.test.ts`:

```ts
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("prompt intelligence tools are registered in the MCP server", async () => {
	const toolSource = await readFile(new URL("../src/tools/prompt-engineering.ts", import.meta.url), "utf8");
	for (const name of ["prompt_build", "prompt_improve", "prompt_evaluate"]) {
		assert.match(toolSource, new RegExp(`server\\.tool\\(\\s*[\"']${name}[\"']`));
	}
	const mcpSource = await readFile(new URL("../src/mcp.ts", import.meta.url), "utf8");
	assert.match(mcpSource, /registerPromptEngineeringTools\(this\.server, env, userId\)/);
});

test("tool surface expects 138 unique tools", async () => {
	const source = await readFile(new URL("../scripts/check-tool-surface.mjs", import.meta.url), "utf8");
	assert.match(source, /src\/tools\/prompt-engineering\.ts/);
	assert.match(source, /EXPECTED_TOOLS = 138/);
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

```bash
node --import tsx --test tests/prompt-tool-surface.test.ts
```

Expected: FAIL because `src/tools/prompt-engineering.ts` does not exist.

- [ ] **Step 3: Implement the thin MCP tool layer**

Create `src/tools/prompt-engineering.ts` with the complete registration module:

```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildPrompt, evaluatePrompt, improvePrompt } from "../utils/prompt-engineering";
import { toolError, toolText } from "../utils/tool-result";

const targetFields = {
	target_tool: z.string().min(1).describe("AI tool that will receive the prompt"),
	target_model: z.string().optional().describe("Specific model when known; omit rather than guess"),
	target_mode: z.enum(["chat", "api", "agent", "ide", "image", "video", "voice", "workflow"]).optional(),
};

export function registerPromptEngineeringTools(server: McpServer, env: Env, userId: string) {
	server.tool("prompt_build", "Build a production-ready prompt for a named AI tool, optionally grounded in relevant personal memory.", {
		objective: z.string().min(1),
		...targetFields,
		output_requirements: z.string().optional(),
		constraints: z.array(z.string()).optional(),
		input_description: z.string().optional(),
		use_memory: z.boolean().default(true),
	}, async (input) => {
		try {
			const result = await buildPrompt(userId, {
				objective: input.objective,
				target: { tool: input.target_tool, model: input.target_model, mode: input.target_mode },
				outputRequirements: input.output_requirements,
				constraints: input.constraints,
				inputDescription: input.input_description,
				useMemory: input.use_memory,
			}, env);
			return toolText(`# Prompt Builder\nRun: ${result.runId} | memories: ${result.memoryIds.length}\n\n${result.output}`);
		} catch (error) { return toolError(error); }
	});

	server.tool("prompt_improve", "Diagnose and rewrite an existing prompt for a named AI tool while preserving its objective and hard constraints.", {
		prompt: z.string().min(1),
		...targetFields,
		known_failure: z.string().optional(),
		preserve: z.array(z.string()).optional(),
		use_memory: z.boolean().default(true),
	}, async (input) => {
		try {
			const result = await improvePrompt(userId, {
				prompt: input.prompt,
				target: { tool: input.target_tool, model: input.target_model, mode: input.target_mode },
				knownFailure: input.known_failure,
				preserve: input.preserve,
				useMemory: input.use_memory,
			}, env);
			return toolText(`# Prompt Improver\nRun: ${result.runId} | memories: ${result.memoryIds.length}\n\n${result.output}`);
		} catch (error) { return toolError(error); }
	});

	server.tool("prompt_evaluate", "Evaluate a prompt for a named AI tool without changing memory. Scores clarity, grounding, scope, output contract, tool fit, token efficiency, and safety.", {
		prompt: z.string().min(1),
		...targetFields,
		intended_outcome: z.string().optional(),
	}, async (input) => {
		try {
			const result = await evaluatePrompt(
				userId,
				input.prompt,
				{ tool: input.target_tool, model: input.target_model, mode: input.target_mode },
				input.intended_outcome,
				env,
			);
			const evaluation = result.evaluation;
			const scores = Object.entries(evaluation.scores)
				.map(([key, value]) => `- ${key}: ${value}`)
				.join("\n");
			return toolText(
				`# Prompt Evaluation\nRun: ${result.runId}\nVerdict: ${evaluation.verdict}\n\n## Scores\n${scores}\n\n## Strengths\n${evaluation.strengths.map((item) => `- ${item}`).join("\n") || "- None identified"}\n\n## Risks\n${evaluation.risks.map((item) => `- ${item}`).join("\n") || "- None identified"}\n\n## Recommended changes\n${evaluation.recommendedChanges.map((item) => `- ${item}`).join("\n") || "- None"}`,
			);
		} catch (error) { return toolError(error); }
	});
}
```

The `prompt_improve` handler returns `# Prompt Improver`, run ID, memory count, and runtime output. The `prompt_evaluate` handler formats the seven scores, verdict, strengths, risks, and recommendations into readable Markdown and includes the run ID.

- [ ] **Step 4: Register the tool module and update the surface checker**

In `src/mcp.ts`:

```ts
import { registerPromptEngineeringTools } from "./tools/prompt-engineering";
```

Call it immediately after `registerAgentOrchestratorTools`.

In `scripts/check-tool-surface.mjs`:

- add `src/tools/prompt-engineering.ts` to `activeFiles`;
- change `EXPECTED_TOOLS` from 135 to 138;
- add an error if `src/mcp.ts` lacks `registerPromptEngineeringTools`.

- [ ] **Step 5: Run focused and surface tests**

```bash
node --import tsx --test tests/prompt-tool-surface.test.ts
npm run test:surface
```

Expected: 2 focused tests pass and `Tool surface verified: 138 tools`.

- [ ] **Step 6: Commit Task 3**

```bash
git add src/tools/prompt-engineering.ts src/mcp.ts scripts/check-tool-surface.mjs tests/prompt-tool-surface.test.ts
git commit -m "feat: expose prompt intelligence MCP tools"
```

---

### Task 4: Prompt agent role and regression coverage

**Files:**
- Modify: `src/types.ts`
- Modify: `src/utils/agents.ts`
- Modify: `tests/prompt-tool-surface.test.ts`

**Interfaces:**
- Produces: `run_agent(role: "prompt")` through the existing generic agent tool.
- Preserves: all existing role values and role-specific system contracts.

- [ ] **Step 1: Add a failing role-wiring test**

Append:

```ts
test("generic agent runner supports the prompt role", async () => {
	const types = await readFile(new URL("../src/types.ts", import.meta.url), "utf8");
	assert.match(types, /AGENT_ROLES[\s\S]*[\"']prompt[\"']/);
	const agents = await readFile(new URL("../src/utils/agents.ts", import.meta.url), "utf8");
	assert.match(agents, /prompt:\s*[\"']/);
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

```bash
node --import tsx --test tests/prompt-tool-surface.test.ts
```

Expected: FAIL because the prompt role is absent.

- [ ] **Step 3: Add the role without changing existing role behaviour**

Append `"prompt"` before `"general"` in `AGENT_ROLES`.

Add to `ROLE_SYSTEM`:

```ts
prompt:
	"You are a memory-aware prompt engineer. Preserve the user's objective and hard constraints, use relevant memory only as labelled context, adapt to the named target tool, expose assumptions, prefer native structured output, bound agentic authority, and avoid obsolete model folklore. Return a paste-ready prompt before concise configuration notes. Australian English.",
```

- [ ] **Step 4: Run the focused test and confirm GREEN**

```bash
node --import tsx --test tests/prompt-tool-surface.test.ts
```

Expected: 3 tests pass, 0 fail.

- [ ] **Step 5: Commit Task 4**

```bash
git add src/types.ts src/utils/agents.ts tests/prompt-tool-surface.test.ts
git commit -m "feat: add prompt agent role"
```

---

### Task 5: Behaviour evaluations and full verification

**Files:**
- Create: `docs/superpowers/evals/prompt-intelligence/README.md`
- Modify only if a verified failure requires it: `src/utils/prompt-engineering.ts`, `src/tools/prompt-engineering.ts`, or their tests.

**Interfaces:**
- Consumes: the old `general` role or baseline prompt behaviour and the new prompt tools.
- Produces: an evidence record covering five evaluation cases.

- [ ] **Step 1: Run five comparison cases**

Evaluate these cases with a baseline agent and the new prompt policy/tool contract:

1. `Build a Claude prompt to review 40,000 tokens of policy documents and answer a question with quotations.`
2. `Improve this Codex prompt: "fix the login bug and clean up anything else you notice". Preserve package.json and do not deploy.`
3. `Build an API prompt that extracts invoice number, amount, due date, and status as machine-readable output.`
4. `Evaluate this Claude 4.6 prompt: assistant prefill "{" followed by "return JSON".`
5. `Improve this research workflow prompt so intermediate evidence is verified before synthesis without banning prompt chaining.`

For each case, check:

- objective and success criteria are explicit;
- target-tool guidance is correct;
- user constraints are preserved;
- assumptions are visible;
- current Claude guidance is used where relevant;
- native schema is preferred for extraction;
- agentic scope and done-state are bounded;
- no obsolete prefill or blanket anti-chaining rule appears.

- [ ] **Step 2: Record results**

Create `docs/superpowers/evals/prompt-intelligence/README.md` before running the cases with this fixed protocol:

```markdown
# Prompt Intelligence Behaviour Evaluation

**Date:** 12 July 2026
**Baseline:** existing general agent/prompt behaviour
**Candidate:** memory-aware prompt intelligence tools

## Cases and required assertions

| Case | Required assertions |
|---|---|
| Long-context Claude | Sources precede the query; quotation grounding and success criteria are explicit |
| Narrow Codex fix | package.json and deployment constraints are preserved; unrelated cleanup is forbidden; done-state is testable |
| Structured extraction | Native response schema or tool calling is preferred over prose JSON alone |
| Claude prefill migration | Final-turn prefill is rejected for Claude 4.6; a supported alternative is supplied |
| Verified prompt chain | Intermediate evidence verification is retained; prompt chaining is not prohibited categorically |

## Results

Record one baseline result and one candidate result for each case. Quote the exact output fragment supporting every pass or failure. A case passes only when all required assertions are supported by the recorded output.

## Residual risks

Record only risks actually observed in the comparison runs. Write `None observed in these five cases` when no residual risk is found.
```

- [ ] **Step 3: Run the complete local gate**

```bash
npm run test:all
git diff --check
```

Expected:

- all Node tests pass;
- `Tool surface verified: 138 tools`;
- TypeScript exits 0;
- `git diff --check` exits 0.

- [ ] **Step 4: Commit the evaluation record and any test-driven corrections**

```bash
git add docs/superpowers/evals/prompt-intelligence/README.md src/utils/prompt-engineering.ts src/tools/prompt-engineering.ts tests/prompt-engineering.test.ts tests/prompt-tool-surface.test.ts
git commit -m "test: verify prompt intelligence behaviour"
```

- [ ] **Step 5: Check deployment credentials without revealing secrets**

```bash
if [ -n "$CLOUDFLARE_API_TOKEN" ]; then echo "CLOUDFLARE_API_TOKEN=set"; else echo "CLOUDFLARE_API_TOKEN=unset"; fi
```

If unset, stop after reporting that local implementation is complete but live deployment is not verified.

- [ ] **Step 6: Deploy and test live only when authenticated**

```bash
npm run deploy
```

Then invoke `prompt_build`, `prompt_improve`, and `prompt_evaluate` through the connected MCP endpoint. Confirm each response has a run ID and the specified output contract. If deployment fails, report the exact failure without claiming the live service is updated.
