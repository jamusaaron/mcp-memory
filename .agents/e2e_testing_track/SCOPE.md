# Scope: E2E Testing Track

## Architecture
- Dual-track opaque-box E2E testing.
- Target features:
  1. `prompt_build` (MCP tool)
  2. `prompt_improve` (MCP tool)
  3. `prompt_evaluate` (MCP tool)
  4. `prompt` agent role (Role system contract)
- Requirements to test:
  - R1: Durable prompt engineering policy & runtime (durable principles, structured output, adaptive thinking, effort control, source material before query).
  - R1: Routing targets by behavioral capability (Claude/Anthropic-specific rules vs general target rules).
  - R1: Memory integration (opt-in via `use_memory`, delimited blocks, returned memory IDs).
  - R1: Validation & repair limits (repair ceiling of at most one repair model call).
  - R2: MCP Tool registration (Zod schemas, tool output format, 113 expected tools).
  - R3: Agent role wiring & system contract.

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | Create TEST_INFRA.md | Feature inventory, methodology, test architecture, and coverage thresholds. | None | DONE |
| 2 | Create E2E Test Cases | Implement `tests/prompt-engineering.test.ts` and `tests/prompt-tool-surface.test.ts` with 4-tier cases (Tier 1-4). | M1 | DONE |
| 3 | E2E Review & Verification | Run reviewer checks on tests to confirm all 4 tiers of tests are implemented and executed. | M2 | DONE |
| 4 | Publish TEST_READY.md | Write test readiness summary table and feature checklist to project root. | M3 | DONE |

## Interface Contracts
- Tests must execute via `npm test` or `node --import tsx --test tests/**/*.test.ts`.
- The tests run as black-box assertions. Since the implementation is not yet written, tests can utilize mock/stub endpoints or run directly expecting failure, or mock the prompt/memory interfaces.
- The tests should define the expected schema, inputs, and behaviors of the new tools and roles.
