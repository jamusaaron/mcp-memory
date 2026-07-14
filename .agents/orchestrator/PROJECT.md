# Project: Memory-Aware Prompt Intelligence Feature Enhancements

## Architecture
- `src/utils/prompt-engineering.ts`: Pure prompt policy, routing, memory-aware runtime orchestration, and logging.
- `src/tools/prompt-engineering.ts`: MCP tool registrations (`prompt_build`, `prompt_improve`, `prompt_evaluate`) and validation schemas.
- Agent Role wiring: Add `prompt` to `AGENT_ROLES` in `src/types.ts` and role system contract in `src/utils/agents.ts`.
- Tool surface checks: Update `scripts/check-tool-surface.mjs` and `src/mcp.ts` to register new tools and assert exactly 113 tools.

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|---|---|---|---|
| 1 | M1: E2E Test Suite | Design and build comprehensive opaque-box E2E test cases (Tier 1-4) in tests/ | None | PLANNED |
| 2 | M2: Policy & Validators | Implement pure prompt-engineering policy, target routing, and JSON score evaluation parsing | None | PLANNED |
| 3 | M3: Orchestration Runtime | Implement memory context formatting, Workers AI calling with repair model call ceiling | M2 | PLANNED |
| 4 | M4: MCP Surface & Role Wiring | Register MCP tools, update check-tool-surface script, and add prompt agent role | M3 | PLANNED |
| 5 | M5: E2E Verification & Hardening | Pass 100% of E2E tests, complete adversarial hardening (Tier 5), write behavior eval docs | M1, M4 | PLANNED |

## Interface Contracts
### `src/utils/prompt-engineering.ts`
- Functions:
  - `buildPrompt(userId, request, env, deps)`
  - `improvePrompt(userId, request, env, deps)`
  - `evaluatePrompt(userId, prompt, target, intendedOutcome, env, deps)`
  - `policyForTarget(target)`
  - `parsePromptEvaluation(text)`
  - `missingSections(output, required)`
- Injectable `PromptRuntimeDependencies` type:
  ```ts
  type PromptRuntimeDependencies = {
      buildContext: typeof buildAgentContext;
      callModel: typeof llmCallSystem;
      logRun: typeof insertAgentRun;
  };
  ```

## Code Layout
- `src/utils/prompt-engineering.ts` (new)
- `src/tools/prompt-engineering.ts` (new)
- `src/mcp.ts` (modified)
- `src/types.ts` (modified)
- `src/utils/agents.ts` (modified)
- `scripts/check-tool-surface.mjs` (modified)
- `tests/prompt-engineering.test.ts` (new)
- `tests/prompt-tool-surface.test.ts` (new)
- `docs/superpowers/evals/prompt-intelligence/README.md` (new)
