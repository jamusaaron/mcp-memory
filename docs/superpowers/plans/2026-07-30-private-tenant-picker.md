# Private Tenant Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (\`- [ ]\`) syntax for tracking.

**Goal:** Let a signed-in console user select an existing memory tenant from a private dropdown before loading its workspace.

**Architecture:** A bounded D1 helper returns tenant IDs, memory counts, and update timestamps without content. An app-access-protected /tenants route serves those summaries. The static console fetches them on startup, renders an accessible native selector, and retains manual entry as a fallback.

**Tech Stack:** Cloudflare Worker, Hono, D1, static HTML/ES modules, Node node:test, TypeScript.

## Global Constraints

- Keep assets.run_worker_first true and do not change /{userId}/sse transport.
- Require the existing same-site session or private Bearer key for /tenants.
- Return only id, memoryCount, and lastUpdated; never return memory, profile, artifact, or agent content.
- Sort by latest memory update descending, then tenant ID ascending; cap results at 100.
- Do not auto-select or auto-load a tenant; manual entry remains available when discovery fails.

---

### Task 1: Add private tenant-summary data and routing

**Files:**

- Modify: src/utils/db.ts
- Modify: src/app.ts
- Create: tests/tenant-summaries.test.ts
- Modify: tests/wrangler-routing.test.ts

**Interfaces:**

- Produces: TenantSummary = { id: string; memoryCount: number; lastUpdated: string | null }.
- Produces: listTenantSummaries(env: Env, limit?: number): Promise<TenantSummary[]>.
- Produces: GET /tenants response { success: true, tenants: TenantSummary[] }.

- [ ] **Step 1: Write the failing helper test**

~~~ts
test("lists bounded tenant summaries without selecting memory content", async () => {
  let sql = "";
  let boundLimit: unknown;
  const env = {
    DB: {
      prepare(statement: string) {
        sql = statement;
        return {
          bind(limit: unknown) {
            boundLimit = limit;
            return {
              all: async () => ({
                results: [{ id: "tenant-b", memoryCount: 2, lastUpdated: "2026-07-30T00:00:00.000Z" }],
              }),
            };
          },
        };
      },
    },
  } as unknown as Env;

  assert.deepEqual(await listTenantSummaries(env, 250), [
    { id: "tenant-b", memoryCount: 2, lastUpdated: "2026-07-30T00:00:00.000Z" },
  ]);
  assert.equal(boundLimit, 100);
  assert.match(sql, /COUNT\(\*\) AS memoryCount/);
  assert.doesNotMatch(sql, /\btext\b|\bcontent\b/i);
});
~~~

- [ ] **Step 2: Verify the test is red**

Run: node --import tsx --test --test-reporter=spec tests/tenant-summaries.test.ts

Expected: FAIL because listTenantSummaries does not exist.

- [ ] **Step 3: Implement the minimum D1 helper**

~~~ts
export type TenantSummary = {
  id: string;
  memoryCount: number;
  lastUpdated: string | null;
};

export async function listTenantSummaries(env: Env, limit = 100): Promise<TenantSummary[]> {
  const boundedLimit = Math.min(100, Math.max(1, Math.trunc(limit)));
  const result = await env.DB.prepare(
    "SELECT userId AS id, COUNT(*) AS memoryCount, MAX(updated_at) AS lastUpdated " +
      "FROM memories GROUP BY userId " +
      "ORDER BY (lastUpdated IS NULL) ASC, lastUpdated DESC, id ASC LIMIT ?",
  ).bind(boundedLimit).all<TenantSummary>();
  return result.results.map((row) => ({
    id: row.id,
    memoryCount: Number(row.memoryCount),
    lastUpdated: row.lastUpdated ?? null,
  }));
}
~~~

Add listTenantSummaries to the existing src/app.ts database import. Register this route before /:userId/health:

~~~ts
app.get("/tenants", async (c) => {
  try {
    return c.json({ success: true, tenants: await listTenantSummaries(c.env) });
  } catch (error) {
    console.error("Error retrieving tenant summaries:", error);
    return c.json({ success: false, error: "Failed to retrieve tenants" }, 500);
  }
});
~~~

- [ ] **Step 4: Extend the private-route regression test**

~~~ts
for (const pathname of ["/tenants", "/tenant/memories", "/tenant/sse"]) {
  const response = await app.fetch(
    new Request(\`https://example.test\${pathname}\`, { headers: { Accept: "application/json" } }),
    env,
    {} as ExecutionContext,
  );
  assert.equal(response.status, 401, \`\${pathname} must be denied without a private session\`);
}
~~~

- [ ] **Step 5: Verify green and commit**

Run: node --import tsx --test --test-reporter=spec tests/tenant-summaries.test.ts tests/wrangler-routing.test.ts tests/app-access.test.ts

Expected: PASS; unauthenticated /tenants is denied before D1 access.

~~~bash
git add src/utils/db.ts src/app.ts tests/tenant-summaries.test.ts tests/wrangler-routing.test.ts
git commit -m "feat: expose private tenant summaries"
~~~

### Task 2: Render selectable tenants in the console

**Files:**

- Modify: static/console.html
- Modify: static/console.mjs
- Modify: tests/console.test.ts
- Modify: tests/static-docs.test.ts

**Interfaces:**

- Consumes: /tenants response items { id, memoryCount, lastUpdated }.
- Produces: tenantOptionLabel(tenant) and selectedTenantId(selectedId, manualId).
- Consumes: existing loadWorkspace(tenantId) and memoryRoute(tenantId, collection, memoryId?).

- [ ] **Step 1: Write failing console tests**

~~~ts
test("formats selectable tenant options with memory counts", () => {
  assert.equal(tenantOptionLabel({ id: "tenant-a", memoryCount: 1 }), "tenant-a — 1 memory");
  assert.equal(tenantOptionLabel({ id: "tenant-b", memoryCount: 2 }), "tenant-b — 2 memories");
});

test("uses manual tenant entry when it is provided", () => {
  assert.equal(selectedTenantId("tenant-a", ""), "tenant-a");
  assert.equal(selectedTenantId("tenant-a", "  tenant-manual  "), "tenant-manual");
});
~~~

Add document assertions for id="tenant-select" and a details manual-entry fallback.

- [ ] **Step 2: Verify the UI tests are red**

Run: node --import tsx --test --test-reporter=spec tests/console.test.ts tests/static-docs.test.ts

Expected: FAIL because the helpers and picker controls do not exist.

- [ ] **Step 3: Add accessible controls and private discovery**

Replace the single tenant field in static/console.html with:

~~~html
<div class="field">
  <label for="tenant-select">Available tenants</label>
  <select id="tenant-select" name="tenantSelect" disabled>
    <option value="">Loading available tenants…</option>
  </select>
</div>
<details class="field">
  <summary>Enter tenant ID manually</summary>
  <label for="tenant-id">Tenant ID</label>
  <input id="tenant-id" name="tenantId" autocomplete="off" />
</details>
~~~

Implement these exports in static/console.mjs:

~~~js
export function tenantOptionLabel(tenant) {
  return \`\${tenant.id} — \${tenant.memoryCount} \${tenant.memoryCount === 1 ? "memory" : "memories"}\`;
}

export function selectedTenantId(selectedId, manualId) {
  return manualId.trim() || selectedId.trim();
}
~~~

Add tenantSelect to elements. Add loadTenantOptions(), which calls request("/tenants"), replaces options using textContent, enables the selector, and does not call loadWorkspace. If discovery fails, preserve manual entry and call setStatus("Unable to load tenant choices. Enter a tenant ID manually.", "error"). Call void loadTenantOptions() after listeners are registered. Submit selectedTenantId(elements.tenantSelect.value, elements.tenantId.value) to the existing loader.

- [ ] **Step 4: Verify green and commit**

Run: node --import tsx --test --test-reporter=spec tests/console.test.ts tests/static-docs.test.ts

Expected: PASS with option-label, manual-fallback, and static-control coverage.

~~~bash
git add static/console.html static/console.mjs tests/console.test.ts tests/static-docs.test.ts
git commit -m "feat: add console tenant picker"
~~~

### Task 3: Release and verify

**Files:**

- No source changes expected.

**Interfaces:**

- Verifies: private /tenants, selector availability, tenant-scoped memory loading, and unchanged MCP routing.

- [ ] **Step 1: Run the full local gate**

Run: npm run test:all

Expected: all tests, the exact tool-surface check, and TypeScript compilation pass.

- [ ] **Step 2: Validate and deploy**

Run: npx wrangler deploy --dry-run

Expected: the Worker bundles with existing bindings and assets.run_worker_first true.

Run: npx wrangler deploy

Expected: Wrangler reports a new production version at https://jamie-mcp-memory.jamusaaron.workers.dev.

- [ ] **Step 3: Verify production behavior**

Create an authenticated same-site session with the private access key. Request /tenants, /console, and /{primaryTenant}/memories without printing memory content.

Expected: /tenants returns the primary tenant summary only, /console returns 200 text/html, the selected tenant memory route returns 200, and unauthenticated /tenants returns 401.

- [ ] **Step 4: Publish the release**

~~~bash
git push origin codex/prompt-intelligence
gh pr edit 12 --repo jamusaaron/mcp-memory --body-file /tmp/mcp-memory-pr-12.md
~~~

Write /tmp/mcp-memory-pr-12.md with the access-fix summary, the tenant-picker behavior, and validation results before gh pr edit.

