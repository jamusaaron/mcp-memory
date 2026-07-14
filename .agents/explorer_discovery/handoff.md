# Handoff Report - explorer_discovery

**Date:** 12 July 2026  
**Agent:** explorer_discovery  
**Task status:** Complete (Hard Handoff)

---

## 1. Observation
- The entry point `src/mcp.ts` registers tools by calls to helper functions within `init()`, such as:
  - Line 33: `registerMemoryTools(this.server, env, userId);`
  - Line 40: `registerAiAgentTools(this.server, env, userId);`
- Tool modules under `src/tools/` define validation schemas using Zod. For example, `src/tools/ai-agents.ts` has tool declarations like:
  ```ts
  server.tool(
      "ai_agents_list",
      "List all AI agents...",
      {},
      async () => { ... }
  );
  ```
- The tool surface check in `scripts/check-tool-surface.mjs` enforces registry expectations:
  - Line 26: `const EXPECTED_TOOLS = 110;`
  - Line 38: `if (names.length !== EXPECTED_TOOLS) errors.push(...)`
- In `package.json`:
  - Line 28: `"agents": "0.7.0"` dependency is present.
  - Line 12: `"test:surface": "node scripts/check-tool-surface.mjs"` script is declared.
- Database queries and schemas reside in `src/schema.ts` and `src/utils/db.ts`. No local configuration files exist for `src/utils/agents.ts` or `src/types.ts` `AGENT_ROLES` array.
- KV storage is accessed via `src/utils/kv.ts` functions (e.g. `getLivingSummary`, `putLivingSummary`, `getSessionState`, `putSessionState`).
- The design document `docs/superpowers/specs/2026-07-12-prompt-intelligence-design.md` details the requested feature interface and guidance.

---

## 2. Logic Chain
- **Step 1:** The tool registration pattern requires creating a new registration module `src/tools/prompt-engineering.ts` that defines the schema and registers the three tools: `prompt_build`, `prompt_improve`, and `prompt_evaluate`.
- **Step 2:** The surface check asserts the exact count of tools (`EXPECTED_TOOLS`). Therefore, after registering three new tools, `scripts/check-tool-surface.mjs` must be updated to include the new file in `activeFiles` and set `EXPECTED_TOOLS` to `113` (110 + 3).
- **Step 3:** The user personalization and model calling orchestration can be isolated inside a new helper module `src/utils/prompt-engineering.ts` leveraging `buildAgentContext` and `llmCallSystem` (to be added or imported).
- **Step 4:** The prompt role must be registered as part of `src/types.ts` (adding `"prompt"` to an `AGENT_ROLES` array) and configured as system instructions in `src/utils/agents.ts` (`ROLE_SYSTEM`), matching specifications in the design doc.
- **Step 5:** Personalization requires calling `buildAgentContext` when `use_memory` is true. Retrieved memories can be formatted into Markdown XML blocks (like `<memory_context>...`) and passed as context to the model call.

---

## 3. Caveats
- The exact location/signature of `llmCallSystem` and `insertAgentRun` is referenced by documentation, but the functions do not yet exist in `src/utils/ai.ts` or `src/utils/db.ts` under those exact names (only `llmCall` and `insertSessionLog` exist). Implementing them or mapping them correctly will be the responsibility of the implementer agent.
- External model endpoints (Cloudflare Workers AI) were not invoked during this read-only discovery.

---

## 4. Conclusion
The current codebase has clear, modular patterns for tool definition, D1 queries, and KV storage. The proposed Prompt Intelligence enhancement is highly feasible by creating two new files (`src/utils/prompt-engineering.ts` and `src/tools/prompt-engineering.ts`) and modifying files like `src/mcp.ts`, `src/types.ts`, `src/utils/agents.ts`, and `scripts/check-tool-surface.mjs` following the five-step milestone outline.

---

## 5. Verification Method
1. Inspect the written discovery report at `/Users/jamieyoung/.gemini/antigravity/worktrees/mcp-memory/teamwork-preview-feature-enhancements/.agents/explorer_discovery/discovery_report.md`.
2. Confirm the expected tool registration, roles, and schema configurations match the observations.
