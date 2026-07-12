# MCP Memory Prompt Intelligence Design

**Date:** 12 July 2026

## Objective

Add a memory-aware prompt-engineering capability to `mcp-memory` that can build, improve, and evaluate prompts for AI tools while preserving user intent, grounding personalisation in retrieved memories, and avoiding stale model-specific folklore.

The first release will add three MCP tools and one reusable prompt-agent role. It will reuse the existing memory retrieval and agent-run audit infrastructure. It will not add prompt versioning tables, automated A/B execution, or outcome tracking.

## Success criteria

The enhancement is complete when:

1. `prompt_build` produces one paste-ready prompt for a named target tool and returns concise configuration and assumption notes.
2. `prompt_improve` identifies concrete failure risks in an existing prompt and returns a rewritten prompt that preserves its stated objective and hard constraints.
3. `prompt_evaluate` returns a structured assessment across clarity, grounding, scope, output contract, target-tool fit, token efficiency, and operational safety without mutating memory.
4. All generative tools may use relevant personal memory when requested, identify that memory-derived context separately, and never silently invent missing facts.
5. Prompt guidance follows current durable principles and explicitly avoids known obsolete patterns.
6. The existing test suite, TypeScript checks, and MCP tool-surface verification pass.
7. A regression test proves the new tools are registered and the prompt-policy layer contains the required modern guidance.
8. Live deployment and an end-to-end tool call are performed only when Cloudflare deployment credentials are available.

## Considered approaches

### Knowledge-only context document

Store the supplied guide and skill as persistent context documents. This is fast but relies on every consuming agent discovering, loading, and interpreting a large body of text consistently. It adds knowledge without a stable callable interface.

### Memory-aware prompt tools — selected

Create purpose-built MCP tools backed by a compact prompt-policy module and the existing memory retrieval pipeline. This produces a predictable interface, keeps prompt construction auditable, and avoids new persistence infrastructure.

### Full prompt lifecycle platform

Add prompt records, versions, test suites, executions, scores, and promotion status in D1. This is valuable later but expands the task into a new subsystem and requires product decisions about evaluation providers, cost controls, and retention.

## Architecture

### `src/utils/prompt-engineering.ts`

Owns the prompt-engineering policy and orchestration helpers. It will:

- define durable guidance shared by all prompt tools;
- route targets by behavioural capability rather than hard-coded product-version lists;
- add Claude-specific rules only when the target identifies Claude or Anthropic;
- format retrieved memory as a clearly delimited context block;
- call `llmCallSystem` with the appropriate operation contract;
- parse and validate the model result into a stable internal result shape;
- log generative prompt runs through the existing `agent_runs` mechanism.

The module will expose:

```ts
type PromptTarget = {
	tool: string;
	model?: string;
	mode?: "chat" | "api" | "agent" | "ide" | "image" | "video" | "voice" | "workflow";
};

type PromptBuildRequest = {
	objective: string;
	target: PromptTarget;
	outputRequirements?: string;
	constraints?: string[];
	inputDescription?: string;
	useMemory: boolean;
};

type PromptImprovementRequest = {
	prompt: string;
	target: PromptTarget;
	knownFailure?: string;
	preserve?: string[];
	useMemory: boolean;
};

type PromptEvaluation = {
	scores: Record<"clarity" | "grounding" | "scope" | "output_contract" | "tool_fit" | "token_efficiency" | "safety", number>;
	strengths: string[];
	risks: string[];
	recommendedChanges: string[];
	verdict: "ready" | "revise" | "insufficient_context";
};
```

### `src/tools/prompt-engineering.ts`

Registers three MCP tools:

#### `prompt_build`

Inputs:

- `objective` — required;
- `target_tool` — required;
- `target_model` — optional;
- `target_mode` — optional behavioural class;
- `output_requirements` — optional;
- `constraints` — optional string array;
- `input_description` — optional;
- `use_memory` — optional, defaults to `true`.

Output contract:

1. `# Prompt` followed by one paste-ready prompt block.
2. `# Configuration` containing only target-specific settings that belong outside the prompt, such as effort, response schema, or attachment instructions.
3. `# Assumptions` listing unresolved assumptions and which memory-derived facts were used.
4. `# Quality check` with the concise result of the internal policy check.

#### `prompt_improve`

Inputs:

- `prompt` and `target_tool` — required;
- `target_model`, `target_mode`, `known_failure`, `preserve`, and `use_memory` — optional.

Output contract:

1. `# Diagnosis` with specific failure risks, not general prompting theory.
2. `# Improved prompt` containing the complete paste-ready replacement.
3. `# Material changes` explaining only changes that affect behaviour or user intent.
4. `# Assumptions` identifying unresolved or memory-derived context.

#### `prompt_evaluate`

Inputs:

- `prompt` and `target_tool` — required;
- `target_model`, `target_mode`, and `intended_outcome` — optional.

The tool is read-only. It does not retrieve personal memory unless the caller supplies an intended outcome requiring comparison with known preferences. It returns the seven numeric scores, evidence-based strengths and risks, recommended changes, and a verdict.

### Agent integration

Add `prompt` to `AGENT_ROLES` and `ROLE_SYSTEM`. `run_agent(role: "prompt")` remains the freeform escape hatch, while the three dedicated tools provide stronger schemas for common operations.

Register `registerPromptEngineeringTools` in `src/mcp.ts` after the existing memory and agent tools. No new Cloudflare binding or database migration is required.

## Prompt policy

The policy will encode durable rules rather than a dated catalogue of model names:

- establish objective, success criteria, target capability, output contract, and hard constraints before adding technique;
- explain relevant motivation where it improves instruction generalisation;
- use examples when format or boundary behaviour is difficult to express, and keep examples aligned with the requested contract;
- use XML or similarly explicit delimiters for complex Claude prompts, variable inputs, or multiple documents;
- prefer native structured output or tool calling over prose-only JSON requests;
- for long-context Claude tasks, place source material before the query and keep the task near the end;
- use adaptive thinking or an effort control when the target supports it; do not require exposed chain-of-thought;
- permit prompt chaining when intermediate verification or context separation materially improves reliability;
- explicitly name tools when action is expected, while avoiding blanket tool-use or subagent mandates;
- bound agentic work with scope, authority, stop conditions, verification, and a concrete done-state;
- add anti-overengineering guidance for coding agents when the requested change is narrow;
- treat model names, parameter availability, and product capabilities as time-sensitive; state uncertainty or request verification instead of guessing;
- do not use final-assistant-message prefilling for Claude 4.6 or later;
- keep memory-derived context distinct from user-supplied facts and list the memories used.

The supplied `prompt-master-main` and Anthropic guide are inputs, not unquestioned authority. Durable guidance is retained; obsolete or contradictory material is excluded. In particular, the implementation will not adopt the guide's universal prefill recommendation or the existing skill's blanket prohibition on prompt chaining.

## Data flow

### Build and improve

1. Validate the MCP input schema.
2. If `use_memory` is true, call `buildAgentContext(userId, objectiveOrPrompt, env)`.
3. Format only relevant context into a delimited memory block with memory IDs.
4. Select the operation-specific system contract and target-specific guidance.
5. Call Workers AI through `llmCallSystem`.
6. Validate that the result includes a complete prompt and required sections.
7. If the result is incomplete, perform one repair call using the validation errors; do not loop indefinitely.
8. Record the run through `insertAgentRun` with role `prompt` and the memory IDs used.
9. Return readable MCP text with the run ID for auditability.

### Evaluate

1. Validate inputs.
2. Build the evaluation contract and target-specific guidance.
3. Call Workers AI once.
4. Parse the seven scores and verdict.
5. Reject or repair malformed score values outside `0..100`.
6. Return the assessment without writing a memory or changing a profile.

## Error handling

- Missing required fields are rejected by Zod before model execution.
- Unsupported or unknown target tools use the declared behavioural mode; if both are ambiguous, the output records a generic-target assumption.
- Workers AI failures return `toolError` with the upstream error preserved.
- Invalid model output receives at most one repair attempt.
- If memory retrieval fails, build and improve continue without personalisation and state that memory context was unavailable.
- If relevant memory records conflict, the prompt does not choose a side silently; assumptions list the conflict.
- Prompt evaluation never stores the evaluated prompt automatically.

## Testing strategy

### Unit and contract tests

- Verify all three tools register with their expected names and schemas.
- Verify the prompt-policy text includes adaptive thinking, native structured output, long-context ordering, scope boundaries, and anti-overengineering guidance.
- Verify it excludes final-turn prefilling as a current-Claude recommendation and does not prohibit prompt chaining.
- Mock Workers AI and confirm build/improve perform at most one repair call.
- Confirm `use_memory: false` avoids memory retrieval.
- Confirm evaluation rejects scores outside `0..100` or repairs them once.

### Behaviour evaluations

Compare the existing general agent behaviour against the new tools on:

1. an ambiguous prompt request requiring assumptions to be exposed;
2. a bloated coding-agent prompt that encourages unrelated refactoring;
3. a structured extraction task that should use a native schema;
4. a long-document Claude task requiring document-first/query-last ordering;
5. a prompt repair request where the original intent and constraints must remain unchanged.

The enhanced tools should outperform the baseline on contract completeness, intent preservation, target-tool fit, explicit assumptions, and absence of obsolete techniques.

## Compatibility and rollout

- Preserve the existing Worker architecture, bindings, D1 schema, and tool-result helpers.
- Preserve every existing MCP tool and role.
- Do not rename `mcp-memory`, change the user namespace, or modify stored memories.
- Update the tool-surface expectation to include the three new tools.
- Run `npm run test:all` before deployment.
- Deploy only with an authenticated Cloudflare environment.
- After deployment, call `prompt_build`, `prompt_improve`, and `prompt_evaluate` through the live MCP connector and confirm the run IDs and output contracts.

## Deferred work

The following are intentionally outside this release:

- D1 prompt/version tables;
- automatic execution of generated prompts against third-party models;
- automated A/B testing and statistical promotion;
- prompt sharing or marketplace features;
- background optimisation jobs;
- automatic storage of every generated prompt as long-term memory.

These can be added later without breaking the three initial tool contracts.
