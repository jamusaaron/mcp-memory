# MCP Audit Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct confirmed runtime errors, remove stale R2 artifacts, enforce the configured rate limit, and make the 97-tool deployment accurately report degraded capabilities.

**Architecture:** Preserve the existing Hono + MCP Agent + D1/KV/Vectorize design and the 97-tool surface. Add small testable utilities for Cloudflare API access and MCP error results, make D1 mutations verify affected rows, and enforce infrastructure checks at request and health boundaries.

**Tech Stack:** TypeScript, Cloudflare Workers, Hono, MCP SDK, D1, KV, Vectorize, Workers AI, Node test runner via `tsx`.

## Global Constraints

- Preserve exactly 97 registered MCP tools.
- Do not add an R2 binding or R2-backed tool.
- Keep the existing endpoint path and client configurations compatible.
- Do not create or store a Cloudflare API token during this cleanup.
- Use test-first changes for every confirmed behavior defect.

---

### Task 1: Add Runtime Regression Tests

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `tests/db.test.ts`
- Create: `tests/cloudflare-api.test.ts`
- Create: `tests/tool-result.test.ts`

**Interfaces:**
- Consumes: existing `updateMemory`, `deleteMemory`, and future Cloudflare API/result helpers.
- Produces: `npm test` and reusable regression coverage for missing rows, upstream API failures, and MCP `isError` responses.

- [ ] **Step 1: Install the TypeScript test runner**

Run: `npm install --save-dev tsx`

- [ ] **Step 2: Add test scripts**

Add `"test": "tsx --test tests/**/*.test.ts"` and `"test:all": "npm test && npm run test:surface && tsc --noEmit"`.

- [ ] **Step 3: Write failing D1 mutation tests**

Test that `updateMemory` and `deleteMemory` reject with `Memory <id> not found` when `D1Result.meta.changes` is zero and resolve when it is one.

- [ ] **Step 4: Write failing Cloudflare API tests**

Test missing-token rejection, non-2xx rejection containing Cloudflare error messages, successful JSON parsing, and session account override.

- [ ] **Step 5: Write failing MCP result tests**

Test that `toolError(new Error("boom"))` returns `{ isError: true, content: [{ type: "text", text: "Error: boom" }] }`.

- [ ] **Step 6: Run tests and verify RED**

Run: `npm test`

Expected: failures for missing helpers and missing-row mutation behavior.

### Task 2: Correct D1 Mutation and Embedding State

**Files:**
- Modify: `src/utils/db.ts`
- Modify: `src/tools/memory.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: D1 `meta.changes`, `storeMemoryVector`, `updateMemory`.
- Produces: truthful not-found failures and `pending`/`embedded` status matching vector state.

- [ ] **Step 1: Reject missing rows in D1 helpers**

Capture each `.run()` result and throw `new Error(\`Memory ${id} not found\`)` when `result.meta.changes === 0`.

- [ ] **Step 2: Make text edits vector-consistent**

Before changing text, set `embedding_status` to `pending`; after a successful upsert set it to `embedded`. If upsert fails, preserve `pending` so `backfill_embeddings` can repair it.

- [ ] **Step 3: Surface write degradation**

When initial embedding fails, keep the memory but append a warning that its embedding remains pending rather than silently reporting a fully successful write.

- [ ] **Step 4: Verify GREEN**

Run: `npm test`

Expected: all D1 mutation tests pass.

### Task 3: Make Cloudflare Admin Tools Truthful

**Files:**
- Create: `src/utils/cloudflare-api.ts`
- Create: `src/utils/tool-result.ts`
- Modify: `src/tools/infra.ts`
- Modify: `src/tools/health.ts`

**Interfaces:**
- Produces: `CloudflareApi.requestJson`, `CloudflareApi.requestText`, `CloudflareApi.setAccountId`, `toolText`, and `toolError`.
- Consumes: optional `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` bindings.

- [ ] **Step 1: Implement strict Cloudflare response validation**

Require a token, reject non-2xx responses, reject JSON payloads with `success: false`, and include upstream error messages in the thrown error.

- [ ] **Step 2: Implement a real session account override**

Store the selected account ID inside the `CloudflareApi` instance created for each MCP Agent and have all account-scoped tools use it.

- [ ] **Step 3: Mark tool failures as MCP errors**

Return `isError: true` for missing credentials, invalid read-only SQL, upstream API failures, and Worker source fetch failures.

- [ ] **Step 4: Report admin capability in health output**

Add `Cloudflare admin API: DISABLED — credentials not configured` or `OK — configured` without treating the core memory subsystem as unhealthy.

- [ ] **Step 5: Verify GREEN**

Run: `npm test`

Expected: all Cloudflare API and result tests pass.

### Task 4: Enforce Request Boundaries and Remove Dead R2 Artifacts

**Files:**
- Modify: `src/index.ts`
- Delete: `src/tools/static-files.ts`
- Delete: `src/utils/r2.ts`
- Regenerate: `worker-configuration.d.ts`
- Modify: `scripts/check-tool-surface.mjs`
- Delete: `scripts/seed-jamie-memory.mjs`

**Interfaces:**
- Consumes: `RATE_LIMITER.limit({ key })`.
- Produces: 429 responses after quota exhaustion, 503 responses when schema initialization fails, and no stale R2 binding/source.

- [ ] **Step 1: Add failing source contracts**

Require active use of `RATE_LIMITER.limit`, forbid the dead R2 source files, and forbid an `R2` property in `Cloudflare.Env`.

- [ ] **Step 2: Enforce rate limiting**

For non-root requests, derive the tenant key from the first path segment and return HTTP 429 when `success` is false.

- [ ] **Step 3: Fail closed on schema initialization errors**

Return HTTP 503 instead of continuing into handlers with an unavailable schema.

- [ ] **Step 4: Remove dead and unsafe scripts**

Delete the unused R2 tool/helper modules and the untracked seeding script containing a deployment-specific endpoint.

- [ ] **Step 5: Regenerate Worker bindings**

Run: `npm run cf-typegen`

Expected: `Cloudflare.Env` has no `R2` binding.

### Task 5: Correct Documentation and Verify Locally

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Produces: documentation matching the 97-tool KV-backed deployment and credential requirements.

- [ ] **Step 1: Correct architecture and security claims**

Document KV-backed persistent context, active rate limiting, URL-key isolation limitations, and the optional Cloudflare admin credentials.

- [ ] **Step 2: Correct project/tool counts**

Replace the stale 105-tool/R2 inventory with the active 97-tool layout.

- [ ] **Step 3: Run the full local gate**

Run: `npm run test:all && npx biome check . && git diff --check`

Expected: zero test, type, formatting, or whitespace failures.

### Task 6: Deploy and Verify Live Behavior

**Files:**
- No source files.

**Interfaces:**
- Consumes: deployed endpoint configured in Claude Desktop and Gemini CLI.
- Produces: live evidence for tool count, health, missing-ID errors, rate-limit binding, and CRUD/search cleanup.

- [ ] **Step 1: Deploy**

Run: `npm run deploy`

- [ ] **Step 2: Verify the live inventory**

Require exactly 97 tools and no forbidden R2 names.

- [ ] **Step 3: Verify corrected error semantics**

Call `edit_memory` and `forget_memory` with a nonexistent UUID; require `isError: true` and a not-found message. Call `accounts_list`; require `isError: true` with a credential diagnostic.

- [ ] **Step 4: Verify core CRUD and semantic retrieval**

Write one synthetic test memory, list it, wait for Vectorize propagation, query it, and delete it.

- [ ] **Step 5: Commit**

Run: `git add ... && git commit -m "fix: harden MCP runtime contracts"`

