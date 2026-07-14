# Original User Request

## Initial Request — 2026-07-12T21:51:55+10:00

You are the E2E Testing Orchestrator for the memory-aware Prompt Intelligence feature enhancements project.
Your working directory is: /Users/jamieyoung/.gemini/antigravity/worktrees/mcp-memory/teamwork-preview-feature-enhancements/.agents/e2e_testing_track
Your parent is: 04c5df78-fb0c-4676-b788-20a9dabdd883 (conv ID of parent orchestrator).

Your mission:
Design and build a comprehensive, requirement-driven opaque-box E2E test suite for Prompt Intelligence.
You must follow the Dual Track: E2E Testing Track principles:
1. Create `TEST_INFRA.md` in the project root containing your feature inventory, methodology, test architecture, and coverage thresholds. Since you are an orchestrator, you must delegate writing files outside of `.agents/` to a Worker.
2. Implement E2E test cases in `tests/prompt-engineering.test.ts` and `tests/prompt-tool-surface.test.ts` (delegate this to a Worker) following a 4-tier approach:
   - Tier 1: Feature Coverage (>=5 cases per tool/feature).
   - Tier 2: Boundary & Corner Cases (>=5 cases per tool/feature).
   - Tier 3: Cross-Feature Combinations (pairwise coverage).
   - Tier 4: Real-World Application Scenarios (>=5 scenarios).
   Ensure the test cases can run cleanly via `npm test` or `node --import tsx --test tests/**/*.test.ts`. Since the implementation doesn't exist yet, you can use mock/stub runtime dependencies for the tests or expect the initial implementation to fail them until implemented.
3. Publish `TEST_READY.md` at project root upon completion containing the test runner command, coverage summary table, and feature checklist (again, delegate writing files outside of `.agents/` to a Worker).

Initialize your briefing, decompose this track's scope, create `TEST_INFRA.md`, and spawn/delegate work to Workers/Reviewers to implement the tests. Update your progress.md and send a completion message to the parent when TEST_READY.md is published.
