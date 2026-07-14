## 2026-07-12T11:52:48Z
Create the file `TEST_INFRA.md` at the project root (/Users/jamieyoung/.gemini/antigravity/worktrees/mcp-memory/teamwork-preview-feature-enhancements/TEST_INFRA.md).

Here is the exact markdown content to write to the file:
```markdown
# E2E Test Infra: Prompt Intelligence Feature Enhancements

## Test Philosophy
- Opaque-box, requirement-driven. No dependency on implementation design.
- Methodology: Category-Partition + BVA + Pairwise + Workload Testing.

## Feature Inventory
| # | Feature | Source (requirement) | Tier 1 | Tier 2 | Tier 3 |
|---|---------|---------------------|:------:|:------:|:------:|
| 1 | prompt_build | ORIGINAL_REQUEST §R1, R2 | 5      | 5      | ✓      |
| 2 | prompt_improve | ORIGINAL_REQUEST §R1, R2 | 5      | 5      | ✓      |
| 3 | prompt_evaluate | ORIGINAL_REQUEST §R1, R2 | 5      | 5      | ✓      |
| 4 | prompt agent role | ORIGINAL_REQUEST §R3     | 5      | 5      | ✓      |

## Test Architecture
- Test runner: Node.js Test Runner (node --import tsx --test tests/**/*.test.ts)
- Test files:
  - `tests/prompt-engineering.test.ts` (testing prompt engineering policy, target routing, validation, memory injection, repair loops, evaluation parsing)
  - `tests/prompt-tool-surface.test.ts` (testing tool registration, schemas, agent role wiring)
- Test case format: node:test structure, using node:assert/strict for verification. Mocks or stubs will be used where necessary to isolate the MCP environment since the actual LLM calls and D1 database are mocked during tests.

## Real-World Application Scenarios (Tier 4)
| # | Scenario | Features Exercised | Complexity |
|---|----------|--------------------|------------|
| 1 | E2E Prompt Build & Evaluation Pipeline | prompt_build, prompt_evaluate | Medium |
| 2 | Prompt Loop with Failure and Auto-Repair | prompt_improve, repair loop | High |
| 3 | Memory-Aware Claude Prompting | prompt_build, memory integration | High |
| 4 | Multi-Agent Role System Integration | prompt agent role, prompt_build | High |
| 5 | E2E Audit Trail and Session Logging | prompt_build, prompt_improve, session logs | Medium |

## Coverage Thresholds
- Tier 1: >=5 cases per feature (20 total)
- Tier 2: >=5 cases per feature (20 total)
- Tier 3: pairwise coverage of major feature interactions (at least 6 combinations)
- Tier 4: >=5 realistic application scenarios
```

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A Forensic Auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

After creating the file, run a quick check that the file exists and has the correct content. Update your progress.md and send a completion message with the path of the file.
