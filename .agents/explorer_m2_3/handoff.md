# Handoff Report — Explorer M2 (Policy & Validators)

## 1. Observation
We examined the design specs, implementation plans, package.json test scripts, and existing tests in the workspace.

### A. Design Specs & Implementation Plan
In `/Users/jamieyoung/.gemini/antigravity/worktrees/mcp-memory/teamwork-preview-feature-enhancements/docs/superpowers/specs/2026-07-12-prompt-intelligence-design.md`:
- **Line 40-50**: Describes prompt-engineering policy requirements: pure logic, Claude routing rules based on tool/model string matching, retrieved memory formatting using distinct XML delimiters, result parsing, and logging of runs.
- **Line 140-160**: Lists durable rules (objective, motivation, aligned examples, preferring native structures, adaptive thinking/effort, prompt chaining permissibility, scope boundaries, anti-overengineering, treating capabilities as time-sensitive, and memory tracking).
- **Line 156**: States: *"do not use final-assistant-message prefilling for Claude 4.6 or later."*
- **Line 159**: States: *"the implementation will not adopt the guide's universal prefill recommendation or the existing skill's blanket prohibition on prompt chaining."*

In `/Users/jamieyoung/.gemini/antigravity/worktrees/mcp-memory/teamwork-preview-feature-enhancements/docs/superpowers/plans/2026-07-12-prompt-intelligence.md`:
- **Line 54-111**: Outlines Step 1 of Task 1, including initial assertions for `PROMPT_POLICY`, `policyForTarget`, `missingSections`, and `parsePromptEvaluation`.
- **Line 711-717**: Outlines tests for checking the prompt agent role wiring in `src/types.ts` and `src/utils/agents.ts`.

### B. Package.json Test Commands
In `/Users/jamieyoung/.gemini/antigravity/worktrees/mcp-memory/teamwork-preview-feature-enhancements/package.json`:
- **Line 10**: `"test": "node --import tsx --test tests/**/*.test.ts"`
- **Line 11**: `"test:all": "npm test && npm run test:surface && tsc --noEmit"`
- **Line 12**: `"test:surface": "node scripts/check-tool-surface.mjs"`

### C. Existing Test File Architecture
In `/Users/jamieyoung/.gemini/antigravity/worktrees/mcp-memory/teamwork-preview-feature-enhancements/tests/tool-result.test.ts`:
- **Line 1-2**: Uses strict assertions and the node test runner:
  ```ts
  import assert from "node:assert/strict";
  import test from "node:test";
  ```

---

## 2. Logic Chain
Based on these observations:
1. The project uses standard Node.js test runner (`node:test`) and strict assertions (`node:assert/strict`) via `tsx` (TypeScript executor) to test utility functions and tool definitions.
2. The prompt policy consists of durable guidelines (`PROMPT_POLICY`) and targeted rules (e.g., `CLAUDE_POLICY` applied via `policyForTarget`).
3. To guarantee compliance with M2 (Policy & Validators) requirements without implementing code, we must specify exact assertions to verify policy, routing, parsing, and constraints.
4. An implementer agent can run the tests using `npm test` or `node --import tsx --test tests/prompt-engineering.test.ts` to ensure assertions pass.

---

## 3. Caveats
- Since this is a read-only investigation, we did not write or modify the actual test files.
- We assumed `buildAgentContext` and `insertAgentRun` will be correctly mocked in the implementation's runtime harness tests, as outlined in the plan.
- The `Env` type is assumed to match the Cloudflare Worker Env declaration, which is stubbed out as `{}` or mocked in tests.

---

## 4. Conclusion

We have formulated a complete list of assertions for policy rules:

### A. General Durable Policy Assertions (on `PROMPT_POLICY`)
Assert that the durable policy template contains the expected guidelines and excludes obsolete or prohibited instructions:
- `assert.match(PROMPT_POLICY, /native structured output/i)` — Preference for native structure over prose JSON.
- `assert.match(PROMPT_POLICY, /adaptive thinking|effort control/i)` — Encouraging adaptive thinking/effort controls.
- `assert.match(PROMPT_POLICY, /source material before the query/i)` — Context placement rule for long context.
- `assert.match(PROMPT_POLICY, /over-engineer/i)` — Banning unnecessary refactors and abstractions.
- `assert.match(PROMPT_POLICY, /prompt chaining/i)` — Accepting prompt chaining.
- `assert.doesNotMatch(PROMPT_POLICY, /never use prompt chaining/i)` — Ensuring prompt chaining is not banned.
- `assert.doesNotMatch(PROMPT_POLICY, /prefill the final assistant/i)` — Guaranteeing prefill isn't universally suggested.
- `assert.match(PROMPT_POLICY, /establish the objective, success criteria/i)` — Specifying intent formulation.
- `assert.match(PROMPT_POLICY, /use aligned examples/i)` — Motivation for examples.
- `assert.match(PROMPT_POLICY, /bound agents/i)` — Authority limits on agentic tools.
- `assert.match(PROMPT_POLICY, /time-sensitive/i)` — Treating capabilities as mutable.

### B. Target-Specific Claude Policy Assertions (on `policyForTarget`)
Assert that targeting Claude/Anthropic adds appropriate rules, while targeting other models does not:
- For `policyForTarget({ tool: "Claude API", model: "Claude 4.6", mode: "api" })`:
  - `assert.match(policy, /XML/i)` — Tags required for complex inputs.
  - `assert.match(policy, /final assistant.*prefill/i)` — Rules regarding prefilling.
  - `assert.match(policy, /adaptive thinking/i)` — Mentioning adaptive thinking.
- For `policyForTarget({ tool: "GPT-4o" })`:
  - `assert.doesNotMatch(policy, /XML/i)` — Ensuring Claude-only instructions are not leaked.
  - `assert.doesNotMatch(policy, /final assistant.*prefill/i)` — Do not leak Claude prefilling advice.

### C. Missing Sections Assertions
Assert that `missingSections(output, required)` identifies missing required Markdown sections:
- `assert.deepEqual(missingSections("# Prompt\n...", ["Prompt", "Configuration"]), [])` — All present.
- `assert.deepEqual(missingSections("# Prompt\n...", ["Prompt", "Configuration"]), ["Configuration"])` — Missing heading identified.

### D. Parser and Score Assertions (on `parsePromptEvaluation`)
Assert that `parsePromptEvaluation` correctly enforces schema constraints:
- `assert.throws(() => parsePromptEvaluation(JSON.stringify({ scores: { clarity: 101 }, verdict: "ready" })), /clarity.*0 and 100/i)` — Score bounds (>100).
- `assert.throws(() => parsePromptEvaluation(JSON.stringify({ scores: { clarity: -1 }, verdict: "ready" })), /clarity.*0 and 100/i)` — Score bounds (<0).
- `assert.throws(() => parsePromptEvaluation(JSON.stringify({ scores: { clarity: 50 }, verdict: "invalid-verdict" })), /verdict/i)` — Invalid verdict type.
- Verify successfully parsed fields: `scores`, `strengths` (string array), `risks` (string array), `recommendedChanges` (string array), and `verdict`.

### E. Runtime & Dependency Assertions
Using the mock harness described in the plan, assert that:
- `use_memory: false` avoids retrieving memory context entirely.
- `use_memory: true` formats context correctly within `<memory_context>...</memory_context>`.
- The system executes at most one repair model call if:
  - Required headings are missing (build/improve).
  - Score bounds are violated or JSON parsing fails (evaluate).
- All tool execution traces are written to `insertAgentRun` with correct properties (user ID, role `prompt` or `prompt-evaluate`, memory IDs).

---

## 5. Verification Method
1. Inspect the candidate tests in `tests/prompt-engineering.test.ts` and `tests/prompt-tool-surface.test.ts` to verify the above assertions are fully implemented.
2. Execute the tests locally with the project test runner:
   ```bash
   npm test
   ```
3. Run the complete validation gate:
   ```bash
   npm run test:all
   ```
   A clean execution of all tests and TypeScript compiler checks ensures policy adherence.
