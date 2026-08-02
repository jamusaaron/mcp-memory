# Complete Tenant Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the private console list every known tenant, load a selected tenant immediately through MCP, and present the interaction as a clear responsive workspace.

**Architecture:** Extend the private D1 tenant-summary helper to discover every `userId` across tenant-scoped tables, then left join memory statistics. The static console consumes the same protected endpoint, loads the existing MCP workspace route on selection, and maintains manual ID entry only as a fallback.

**Tech Stack:** Cloudflare Worker, Hono, D1, static HTML and ES modules, Node `node:test`, TypeScript.

## Global Constraints

- Keep `assets.run_worker_first: true` and preserve `/{userId}/sse` transport behavior.
- Keep `/tenants` authenticated and return only `id`, `memoryCount`, and `lastUpdated`.
- Do not embed tenant data in static HTML or introduce a public tenant API.
- Use the existing `/:userId/workspace` MCP bridge for console reads.
- Retain the manual tenant-ID fallback for tenants with no D1 record.

---

### Task 1: Discover every known tenant without exposing content

**Files:**
- Modify: `src/utils/db.ts`
- Modify: `tests/tenant-summaries.test.ts`

**Interfaces:**
- Produces: `listTenantSummaries(env: Env): Promise<TenantSummary[]>`.
- Returns: every `{ id: string; memoryCount: number; lastUpdated: string | null }` known to D1.

- [ ] **Step 1: Write the failing discovery regression test**

```ts
assert.match(sql, /WITH known_tenants AS/i);
assert.match(sql, /UNION\s+SELECT userId FROM derived_artifacts/i);
assert.match(sql, /COALESCE\(memory_summary\.memoryCount, 0\)/i);
assert.doesNotMatch(sql, /\btext\b|\bcontent\b|\bvalue\b/i);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test --test-reporter=spec tests/tenant-summaries.test.ts`

Expected: the existing memory-only query fails the complete-known-tenant assertions.

- [ ] **Step 3: Implement one complete, deterministic D1 query**

```ts
const result = await env.DB.prepare(
  "WITH known_tenants AS (SELECT userId FROM memories UNION SELECT userId FROM people ...), " +
    "memory_summary AS (SELECT userId, COUNT(*) AS memoryCount, MAX(updated_at) AS lastUpdated FROM memories GROUP BY userId) " +
    "SELECT known_tenants.userId AS id, COALESCE(memory_summary.memoryCount, 0) AS memoryCount, memory_summary.lastUpdated AS lastUpdated " +
    "FROM known_tenants LEFT JOIN memory_summary ON memory_summary.userId = known_tenants.userId " +
    "ORDER BY (lastUpdated IS NULL) ASC, lastUpdated DESC, id ASC",
).all<TenantSummary>();
```

Use one `UNION` branch for every tenant-scoped table in `src/schema.ts` and `src/migrations.ts`; do not select a content-bearing column.

- [ ] **Step 4: Run focused tests**

Run: `node --import tsx --test --test-reporter=spec tests/tenant-summaries.test.ts tests/wrangler-routing.test.ts`

Expected: the endpoint remains private and the summary has no content fields.

### Task 2: Make the tenant selector immediate and clear

**Files:**
- Modify: `static/console.html`
- Modify: `static/console.mjs`
- Modify: `tests/console.test.ts`
- Modify: `tests/static-docs.test.ts`

**Interfaces:**
- Consumes: `GET /tenants` summaries and `/:userId/workspace` snapshots.
- Produces: `tenantPickerSummary(count)`, `tenantOptionLabel(tenant)`, and immediate selector loading.

- [ ] **Step 1: Write the failing UI helper and static-markup tests**

```js
assert.equal(tenantPickerSummary(1), "1 known tenant");
assert.equal(tenantPickerSummary(4), "4 known tenants");
assert.match(menu, /id="tenant-refresh"/);
assert.match(menu, /id="tenant-summary"/);
```

- [ ] **Step 2: Run the UI tests to verify they fail**

Run: `node --import tsx --test --test-reporter=spec tests/console.test.ts tests/static-docs.test.ts`

Expected: helper and picker controls are absent.

- [ ] **Step 3: Implement automatic selection, refresh, and busy state**

```js
elements.tenantSelect.addEventListener("change", () => {
  const tenantId = elements.tenantSelect.value.trim();
  if (tenantId) void loadWorkspace(tenantId);
});

elements.tenantRefresh.addEventListener("click", () => void loadTenantOptions());
```

Update `loadTenantOptions()` to populate every private summary, show the count, preserve the active choice when present, and re-enable controls after either success or failure. During `loadWorkspace()`, disable the selector and refresh button; always restore them in a `finally` block if the active request is still current.

- [ ] **Step 4: Refresh the responsive control panel**

Keep the native `<select>` and dark visual system. Add a labeled tenant count, a visible refresh button, selection helper text, and a compact active-tenant indicator. Make control and status spacing touch-friendly at the current mobile breakpoint. Keep manual entry in a closed `<details>` fallback.

- [ ] **Step 5: Run focused UI tests**

Run: `node --import tsx --test --test-reporter=spec tests/console.test.ts tests/static-docs.test.ts`

Expected: immediate-loading helpers, full picker controls, and the manual fallback are covered.

### Task 3: Verify and release

**Files:**
- Modify: `docs/superpowers/specs/2026-08-02-complete-tenant-picker-design.md`
- Modify: `docs/superpowers/plans/2026-08-02-complete-tenant-picker.md`

**Interfaces:**
- Verifies: private tenant discovery, MCP workspace reads, unchanged MCP route surface, and static console behavior.

- [ ] **Step 1: Run the complete local gate**

Run: `npm run test:all`

Expected: every test, exact 153-tool surface check, and TypeScript compilation pass.

- [ ] **Step 2: Validate the production Worker bundle**

Run: `npx wrangler deploy --dry-run`

Expected: the Worker bundles with existing D1, Durable Object, assets, and MCP bindings.

- [ ] **Step 3: Deploy and publish the reviewed change**

Run: `npx wrangler deploy`

Run: `git add src/utils/db.ts static/console.html static/console.mjs tests/tenant-summaries.test.ts tests/console.test.ts tests/static-docs.test.ts docs/superpowers/specs/2026-08-02-complete-tenant-picker-design.md docs/superpowers/plans/2026-08-02-complete-tenant-picker.md && git commit -m "feat: simplify complete tenant selection"`

Run: `git push origin codex/prompt-intelligence`

Expected: the deployed private console presents the complete tenant dropdown and the pull request branch contains the release commit.
