# Scope: Implementation Track

## Architecture
- Implementation of memory-aware Prompt Intelligence features.
- Files affected:
  - `src/utils/prompt-engineering.ts` (Policies, validators, memory formatting, repair logic, calling Workers AI)
  - `tests/prompt-engineering.test.ts` (Unit tests)
  - `src/tools/prompt-engineering.ts` (MCP tool registration)
  - `src/mcp.ts` (Wiring tools to server)
  - `src/types.ts` and `src/utils/agents.ts` (Wiring of the `prompt` role)
  - `scripts/check-tool-surface.mjs` (Update target count to 113 tools)

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M2 | Policy & Validators | Implement policies/validators and unit tests in prompt-engineering | None | DONE |
| M3 | Orchestration Runtime | Implement memory block formatting, Workers AI calling with repair logic | M2 | IN_PROGRESS |
| M4 | MCP Surface & Role Wiring | Register MCP tools, wire prompt role, and update tool surface checks | M3 | PLANNED |
| M5.1 | E2E Phase 1 | Run and fix implementation against E2E test Tiers 1-4 | M4, E2E Test Suite Ready | PLANNED |
| M5.2 | E2E Phase 2 | Tier 5 adversarial coverage hardening (Challengers + fixes) | M5.1 | PLANNED |

## Interface Contracts
- Detailed specifications for prompt engineering APIs, validation schemas, tool signatures, and role types.
- Check tool surface target count: 113 tools.
