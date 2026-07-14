# Original User Request

## Initial Request — 2026-07-12T11:46:41Z

Implement memory-aware Prompt Intelligence feature enhancements for `mcp-memory`, adding three prompt-engineering MCP tools (`prompt_build`, `prompt_improve`, and `prompt_evaluate`) and a reusable `prompt` agent role while preserving full compatibility with existing tools and storage.

Working directory: /Users/jamieyoung/.gemini/antigravity/worktrees/mcp-memory/teamwork-preview-feature-enhancements
Integrity mode: benchmark

## Requirements

### R1. Core Prompt Engineering Policy & Runtime (`src/utils/prompt-engineering.ts`)
Implement request/result types, durable prompt policy, target capability routing, memory formatting, validation, repair, runtime orchestration, and audit logging.
- Ensure prompt guidance follows modern durable principles (structured output, adaptive thinking/effort control, source material before query).
- Route targets by behavioral capability and only inject Claude/Anthropic-specific rules when the target identifies Claude/Anthropic.
- Use retrieved memory only when `use_memory` is true, label it separately as a delimited context block, and return the memory IDs used.
- Perform at most one repair model call after malformed output.

### R2. MCP Tool Registration & Surface Update (`src/tools/prompt-engineering.ts` & `src/mcp.ts`)
Create Zod schemas and register three new MCP tools:
1. `prompt_build`: Produces a paste-ready prompt for a target tool and returns configuration and assumption notes.
2. `prompt_improve`: Identifies failure risks in an existing prompt and returns an improved prompt preserving original objectives and constraints.
3. `prompt_evaluate`: Evaluates a prompt across clarity, grounding, scope, output contract, target-tool fit, token efficiency, and operational safety without mutating memory.
- Register `registerPromptEngineeringTools` in `src/mcp.ts`.
- Update `scripts/check-tool-surface.mjs` to include `src/tools/prompt-engineering.ts` in `activeFiles` and increase `EXPECTED_TOOLS` by exactly 3 (from 110 to 113).

### R3. Add `prompt` Agent Role (`src/types.ts` & `src/utils/agents.ts`)
Add `prompt` to `AGENT_ROLES` in `src/types.ts` and define the `prompt` role system contract in `src/utils/agents.ts`.

### R4. Test Coverage & Evaluation Documentation
- Create `tests/prompt-engineering.test.ts` testing policy, target routing, section validation, evaluation parsing, memory opt-out/fallback, and repair ceiling.
- Create `tests/prompt-tool-surface.test.ts` to assert source-level registration and role wiring.
- Create `docs/superpowers/evals/prompt-intelligence/README.md` documenting behavior-evaluation cases.

## Acceptance Criteria

### Automated Tests & Surface Verification
- [ ] `npm run test:all` executes cleanly without errors (including TypeScript type-check `tsc --noEmit`, unit tests, and `npm run test:surface`).
- [ ] `node scripts/check-tool-surface.mjs` passes and verifies exactly 113 registered MCP tools with no duplicates or forbidden tools.
- [ ] No new D1 database migrations or unexpected table alterations are added.
