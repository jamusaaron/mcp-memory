## 2026-07-12T11:55:43Z
You are a Worker for M2 (Policy & Validators) in the Prompt Intelligence project.
Your working directory is: /Users/jamieyoung/.gemini/antigravity/worktrees/mcp-memory/teamwork-preview-feature-enhancements/.agents/worker_m2

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A Forensic Auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Your task:
1. Implement the durable prompt engineering policy and pure validator functions in a new file `src/utils/prompt-engineering.ts`.
   Follow the design specs and the Task 1 implementation plan:
   - Export types: `PromptTarget`, `PromptBuildRequest`, `PromptImprovementRequest`, `PromptEvaluation`.
   - Export constants: `PROMPT_POLICY`, `CLAUDE_POLICY`.
   - Export functions:
     - `policyForTarget(target: PromptTarget): string`
     - `missingSections(output: string, required: string[]): string[]`
     - `parsePromptEvaluation(text: string): PromptEvaluation`
   - You can also add `extractJsonObject` (utility to extract and parse the first JSON object from a string) to `src/utils/ai.ts` or implement it locally as needed, but adding it to `src/utils/ai.ts` is cleaner. Ensure `src/utils/ai.ts` compiles.
2. Create `tests/prompt-engineering.test.ts` containing the unit tests for Task 1:
   - Policy matches (checks for native structured output, adaptive thinking, source ordering, and exclusions of universal prefill/blanket chaining bans).
   - Claude routing (asserts XML delimiters, prefilling rules, adaptive thinking are appended for Claude targets, and NOT for others).
   - Missing sections checks (verify correct identification of missing headings like # Prompt).
   - Evaluation parser checks (verify Zod parsing or custom parsing of the evaluation scores, ensuring clarity/grounding/etc. are validated to be between 0 and 100, and verdicts are validated).
3. Run the unit tests to confirm they are all passing:
   `node --import tsx --test tests/prompt-engineering.test.ts`
4. Run `npm test` and `npx tsc --noEmit` to ensure everything compiles and passes cleanly.
5. Create a handoff report in `/Users/jamieyoung/.gemini/antigravity/worktrees/mcp-memory/teamwork-preview-feature-enhancements/.agents/worker_m2/handoff.md` detailing:
   - What was implemented (with code snippets and file paths)
   - The test commands run and their output
   - Any assumptions or caveats.
6. When complete, send a message back to me (the parent orchestrator) with a summary.
