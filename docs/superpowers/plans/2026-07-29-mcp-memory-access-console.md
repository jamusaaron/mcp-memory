# MCP Memory Access-Protected Management Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a single-owner, Cloudflare Access-protected memory-management console at the Worker root without exposing static assets, REST memory routes, or MCP/SSE transport.

**Architecture:** Cloudflare Access enforces the owner-only policy at the `workers.dev` edge; a Worker middleware independently validates `Cf-Access-Jwt-Assertion` before every HTTP handler. The root becomes a static option menu, `/console` is a same-origin management workspace, and the existing technical reference moves to `/docs`.

**Tech Stack:** Cloudflare Workers, Hono, Cloudflare Access JWTs, `jose`, Workers Assets, D1/Vectorize-backed REST endpoints, semantic HTML/CSS, browser Fetch API, Node.js test runner, TypeScript/tsx, Wrangler.

## Global Constraints

- Require Cloudflare Access for root, console, docs, REST, health, and MCP/SSE; no route is exempt.
- Fail closed with a generic `403` when Access configuration, token, issuer, signature, or audience is invalid.
- Declare `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` as required Wrangler secrets; never commit their values, a JWT, or a service token.
- Retain `assets.run_worker_first: true` and ensure static page routes precede parameterized tenant routes.
- The Access policy permits the owner identity only. Do not add multi-user mapping or tenant authorization rules.
- Keep the console same-origin, dependency-free, and free of analytics, external fonts, client storage, and third-party requests.
- Keep tenant selection in current page state only; do not use the URL, local storage, session storage, or cookies for it.
- Use existing `/{userId}/health` and `/{userId}/memories` contracts; do not add a second browser API.
- Move, do not weaken, the developer-reference safety content. Its no-browser-fetch contract applies to `/docs`, not `/console`.
- A delete request must require a second explicit UI action. A cancelled delete must issue no request.
- Regenerate `worker-configuration.d.ts` through Wrangler after configuration changes; do not hand-write `Env` bindings.
- Do not deploy until the Access application, owner-only policy, and both required Worker secrets exist.

---

## File Structure

- `wrangler.jsonc` — declares required Access configuration secrets without values.
- `worker-configuration.d.ts` — generated binding types including both Access secrets.
- `package.json` / `package-lock.json` — records the production JWT verifier dependency.
- `src/access.ts` — testable JWT verification and Hono Access middleware.
- `src/index.ts` — installs the Access guard first and maps `/`, `/console`, and `/docs` through `ASSETS`.
- `static/index.html` — authenticated option menu.
- `static/console.html` / `static/console.mjs` — accessible management workspace and tested browser helpers.
- `static/docs.html` — moved technical developer reference.
- `tests/access.test.ts` — Access guard behavior under missing, rejected, and accepted claims.
- `tests/static-docs.test.ts` / `tests/console.test.ts` / `tests/wrangler-routing.test.ts` — static, console-helper, and route-order contracts.
- `CLAUDE.md` — repository map for menu, console, docs, and Access protection.

## Task 1: Add the fail-closed Cloudflare Access boundary

**Files:**
- Modify: `package.json`, `package-lock.json`, `wrangler.jsonc`, `worker-configuration.d.ts`
- Create: `src/access.ts`, `tests/access.test.ts`

**Interfaces:**
- Consumes: `Cf-Access-Jwt-Assertion`, `Env.ACCESS_TEAM_DOMAIN`, and `Env.ACCESS_AUD`.
- Produces: `accessMiddleware()` for Hono and `verifyAccessJwt()` for unit tests.

- [ ] **Step 1: Add the JWT dependency and declare required secret names**

Run:

```bash
npm install jose
```

Add this top-level configuration after `observability` in `wrangler.jsonc`:

```jsonc
"secrets": {
  "required": ["ACCESS_TEAM_DOMAIN", "ACCESS_AUD"]
},
```

Run:

```bash
npx wrangler types
```

Expected: `jose` is a production dependency and generated types contain `ACCESS_TEAM_DOMAIN: string` and `ACCESS_AUD: string`.

- [ ] **Step 2: Write the failing Access middleware test**

Create `tests/access.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { accessMiddleware, type AccessJwtVerifier } from "../src/access";

const config = {
  ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
  ACCESS_AUD: "expected-audience",
};

const protectedApp = (verify: AccessJwtVerifier) => {
  const app = new Hono<{ Bindings: typeof config }>();
  app.use("*", accessMiddleware(verify));
  app.get("/protected", (c) => c.text("allowed"));
  return app;
};

test("blocks a protected route when configuration or assertion is missing", async () => {
  let called = false;
  const app = protectedApp(async () => { called = true; });
  const response = await app.fetch(new Request("https://example.test/protected"), {
    ACCESS_TEAM_DOMAIN: "",
    ACCESS_AUD: "",
  });

  assert.equal(response.status, 403);
  assert.equal(await response.text(), "Access denied");
  assert.equal(called, false);
});

test("blocks rejected assertions before the protected handler", async () => {
  const app = protectedApp(async () => { throw new Error("invalid issuer or audience"); });
  const response = await app.fetch(
    new Request("https://example.test/protected", {
      headers: { "Cf-Access-Jwt-Assertion": "invalid.jwt.value" },
    }),
    config,
  );

  assert.equal(response.status, 403);
  assert.equal(await response.text(), "Access denied");
});

test("allows a verifier-confirmed assertion with the configured Access values", async () => {
  const seen: Array<{ token: string; teamDomain: string; audience: string }> = [];
  const app = protectedApp(async (token, options) => {
    seen.push({ token, teamDomain: options.teamDomain, audience: options.audience });
  });
  const response = await app.fetch(
    new Request("https://example.test/protected", {
      headers: { "Cf-Access-Jwt-Assertion": "verified.jwt.value" },
    }),
    config,
  );

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "allowed");
  assert.deepEqual(seen, [{ token: "verified.jwt.value", teamDomain: config.ACCESS_TEAM_DOMAIN, audience: config.ACCESS_AUD }]);
});
```

- [ ] **Step 3: Run the focused test and confirm red**

Run:

```bash
node --import tsx --test tests/access.test.ts
```

Expected: FAIL with `Cannot find module '../src/access'` because the security boundary does not exist.

- [ ] **Step 4: Implement the minimal Access verifier and middleware**

Create `src/access.ts`:

```ts
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { MiddlewareHandler } from "hono";

export type AccessJwtOptions = { teamDomain: string; audience: string };
export type AccessJwtVerifier = (token: string, options: AccessJwtOptions) => Promise<void>;

export async function verifyAccessJwt(token: string, options: AccessJwtOptions): Promise<void> {
  const certs = createRemoteJWKSet(new URL(`${options.teamDomain}/cdn-cgi/access/certs`));
  await jwtVerify(token, certs, { issuer: options.teamDomain, audience: options.audience });
}

export function accessMiddleware(
  verify: AccessJwtVerifier = verifyAccessJwt,
): MiddlewareHandler<{ Bindings: Pick<Env, "ACCESS_TEAM_DOMAIN" | "ACCESS_AUD"> }> {
  return async (c, next) => {
    const teamDomain = c.env.ACCESS_TEAM_DOMAIN?.replace(/\/+$/, "") ?? "";
    const audience = c.env.ACCESS_AUD ?? "";
    const token = c.req.header("Cf-Access-Jwt-Assertion");
    if (!teamDomain || !audience || !token) return c.text("Access denied", 403);
    try {
      await verify(token, { teamDomain, audience });
    } catch {
      return c.text("Access denied", 403);
    }
    await next();
  };
}
```

Do not require an email claim: a valid owner-browser Access token and a valid policy-authorized service token must both pass issuer/audience verification.

- [ ] **Step 5: Verify green and commit Task 1**

Run:

```bash
node --import tsx --test tests/access.test.ts
npx wrangler types
tsc --noEmit
git add package.json package-lock.json wrangler.jsonc worker-configuration.d.ts src/access.ts tests/access.test.ts
git commit -m "feat: require verified cloudflare access tokens"
```

Expected: all commands exit `0`; the test proves rejected assertions do not reach the protected route.

## Task 2: Protect routing before static, REST, and MCP handling

**Files:**
- Modify: `src/index.ts`, `tests/wrangler-routing.test.ts`

**Interfaces:**
- Consumes: `accessMiddleware()` and the existing `ASSETS` binding.
- Produces: protected `/`, `/console`, `/docs`, REST, health, and MCP routes.

- [ ] **Step 1: Write the failing route-order contract**

Append this test to `tests/wrangler-routing.test.ts`:

```ts
test("protects every HTTP handler before CORS, assets, REST, and MCP dispatch", async () => {
  const index = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const guard = index.indexOf('app.use("*", accessMiddleware())');
  const cors = index.indexOf('app.use(\n\t"*",\n\tcors(');
  const root = index.indexOf('app.get("/",');
  const mcp = index.indexOf('app.mount("/",');

  assert.ok(guard >= 0, "the Access guard must be installed");
  assert.ok(guard < cors);
  assert.ok(guard < root);
  assert.ok(guard < mcp);
});
```

- [ ] **Step 2: Run focused routing test and confirm red**

Run:

```bash
node --import tsx --test tests/wrangler-routing.test.ts
```

Expected: FAIL because `accessMiddleware()` is not registered in `src/index.ts`.

- [ ] **Step 3: Register the guard first and map explicit static assets**

Import and install the middleware before the CORS middleware:

```ts
import { accessMiddleware } from "./access";

app.use("*", accessMiddleware());
```

Add this request-rewriting helper:

```ts
function assetRequest(request: Request, pathname: string): Request {
  const url = new URL(request.url);
  url.pathname = pathname;
  return new Request(url, request);
}
```

Replace the current root-only asset handler with these handlers before parameterized tenant routes:

```ts
app.get("/", (c) => c.env.ASSETS.fetch(assetRequest(c.req.raw, "/index.html")));
app.get("/console", (c) => c.env.ASSETS.fetch(assetRequest(c.req.raw, "/console.html")));
app.get("/docs", (c) => c.env.ASSETS.fetch(assetRequest(c.req.raw, "/docs.html")));
```

Leave `app.mount("/", ...)` last. Do not exempt `/health` from Access.

- [ ] **Step 4: Verify green and commit Task 2**

Run:

```bash
node --import tsx --test tests/access.test.ts tests/wrangler-routing.test.ts
git add src/index.ts tests/wrangler-routing.test.ts
git commit -m "feat: protect worker routes with access middleware"
```

Expected: Access tests and route-order contract pass; no storage or MCP tool code changes.

## Task 3: Split the start menu from the developer reference

**Files:**
- Rename: `static/index.html` to `static/docs.html`
- Create: `static/index.html`
- Modify: `tests/static-docs.test.ts`, `CLAUDE.md`

**Interfaces:**
- Consumes: the moved reference and `/docs` route from Task 2.
- Produces: no-fetch developer-reference assertions for `docs.html` and a root menu that links to `/console` and `/docs`.

- [ ] **Step 1: Write the failing static-contract update**

Change the existing documentation tests to load `../static/docs.html`. Add this test:

```ts
test("publishes an authenticated console start menu without tenant data", async () => {
  const menu = await readFile(new URL("../static/index.html", import.meta.url), "utf8");

  assert.match(menu, /Manage memories/);
  assert.match(menu, /href="\/console"/);
  assert.match(menu, /Connect an AI/);
  assert.match(menu, /href="\/docs#connection"/);
  assert.match(menu, /Developer reference/);
  assert.match(menu, /href="\/docs"/);
  assert.match(menu, /Service health/);
  assert.match(menu, /href="\/docs#operations"/);
  assert.doesNotMatch(menu, /\{userId\}|localStorage|sessionStorage|fetch\(/i);
});
```

- [ ] **Step 2: Run the static contract and confirm red**

Run: `node --import tsx --test tests/static-docs.test.ts`

Expected: FAIL because `static/docs.html` does not exist and root is still the developer reference.

- [ ] **Step 3: Move the reference and create the four-option root menu**

Run: `git mv static/index.html static/docs.html`

Create a dependency-free dark `static/index.html` with these exact menu links:

```html
<nav aria-label="MCP Memory options">
  <a class="menu-card primary" href="/console"><span>01</span><strong>Manage memories</strong><small>Browse, create, revise, and remove records in a selected tenant.</small></a>
  <a class="menu-card" href="/docs#connection"><span>02</span><strong>Connect an AI</strong><small>Open the MCP connection guide and client configuration examples.</small></a>
  <a class="menu-card" href="/docs"><span>03</span><strong>Developer reference</strong><small>Review routes, safety boundaries, and the current tool surface.</small></a>
  <a class="menu-card" href="/docs#operations"><span>04</span><strong>Service health</strong><small>Open authenticated operations and verification guidance.</small></a>
</nav>
```

Add a `Back to console` link near the `docs.html` header. Preserve every existing heading, `{userId}` example, copy-feedback state, dark token, reduced-motion rule, and no-fetch reference rule in `docs.html`.

Update `CLAUDE.md` so its repository map describes `static/index.html` as the Access-protected menu, `static/console.html` as the Access-protected workspace, and `static/docs.html` as the technical reference.

- [ ] **Step 4: Verify green and commit Task 3**

Run: `node --import tsx --test tests/static-docs.test.ts`

Run: `git diff --check`

Run: `git add static/index.html static/docs.html tests/static-docs.test.ts CLAUDE.md`

Run: `git commit -m "feat: add protected memory console start menu"`

Expected: tests pass, the reference remains dependency-free, and root contains no tenant data.

## Task 4: Build the tenant-scoped management workspace

**Files:**
- Create: `static/console.html`, `static/console.mjs`, `tests/console.test.ts`

**Interfaces:**
- Consumes: authenticated same-origin `/{userId}/health`, `/{userId}/memories`, and `/{userId}/memories/{memoryId}` responses.
- Produces: `filterMemories`, `memoryRoute`, and `requiresDeleteConfirmation` exports plus an accessible browser workspace.

- [ ] **Step 1: Write executable console helper tests**

Create `tests/console.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { filterMemories, memoryRoute, requiresDeleteConfirmation } from "../static/console.mjs";

const memories = [
  { id: "a", content: "Prefer concise technical notes", category: "preference", layer: "core", tags: ["writing"], pinned: true },
  { id: "b", content: "Complete project review", category: "task", layer: "current", tags: ["planning"], pinned: false },
];

test("filters only loaded tenant records by text, category, and layer", () => {
  assert.deepEqual(filterMemories(memories, { query: "technical", category: "", layer: "" }).map((memory) => memory.id), ["a"]);
  assert.deepEqual(filterMemories(memories, { query: "", category: "task", layer: "current" }).map((memory) => memory.id), ["b"]);
  assert.deepEqual(filterMemories(memories, { query: "", category: "preference", layer: "current" }), []);
});

test("builds encoded same-origin tenant routes", () => {
  assert.equal(memoryRoute("tenant/one", "memories"), "/tenant%2Fone/memories");
  assert.equal(memoryRoute("tenant one", "memories", "memory/one"), "/tenant%20one/memories/memory%2Fone");
});

test("requires the selected memory id before allowing delete", () => {
  assert.equal(requiresDeleteConfirmation("memory-42", "memory-42"), true);
  assert.equal(requiresDeleteConfirmation("memory-42", "MEMORY-42"), false);
  assert.equal(requiresDeleteConfirmation("memory-42", ""), false);
});
```

- [ ] **Step 2: Run focused console tests and confirm red**

Run: `node --import tsx --test tests/console.test.ts`

Expected: FAIL with `Cannot find module '../static/console.mjs'` because the console module does not exist.

- [ ] **Step 3: Implement pure helpers before browser wiring**

Create `static/console.mjs`:

```js
export function memoryRoute(tenantId, collection, memoryId) {
  const tenant = encodeURIComponent(tenantId.trim());
  const base = `/${tenant}/${collection}`;
  return memoryId ? `${base}/${encodeURIComponent(memoryId)}` : base;
}

export function filterMemories(memories, filters) {
  const query = filters.query.trim().toLocaleLowerCase();
  return memories.filter((memory) => {
    const haystack = [memory.content, memory.category, memory.layer, ...(memory.tags ?? [])]
      .join(" ")
      .toLocaleLowerCase();
    return (!query || haystack.includes(query))
      && (!filters.category || memory.category === filters.category)
      && (!filters.layer || memory.layer === filters.layer);
  });
}

export function requiresDeleteConfirmation(memoryId, confirmation) {
  return Boolean(memoryId) && confirmation === memoryId;
}
```

Keep `{ tenantId, index, memories, selectedId, pendingDeleteId }` only in module-local page state. Use `fetch(memoryRoute(...), { credentials: "same-origin" })` exclusively with relative `memoryRoute` outputs. Clear every tenant-bound state property before a tenant switch completes.

- [ ] **Step 4: Create the accessible console page and bind actions**

Create `static/console.html` with this module entry point and essential controls:

```html
<script type="module" src="/console.mjs"></script>

<form id="tenant-form">
  <label for="tenant-id">Tenant ID</label>
  <input id="tenant-id" name="tenantId" autocomplete="off" required />
  <button type="submit">Load workspace</button>
</form>
<p id="console-status" aria-live="polite"></p>

<form id="memory-form" hidden>
  <label for="memory-content">Memory</label>
  <textarea id="memory-content" name="content" required></textarea>
  <label for="memory-category">Category</label>
  <input id="memory-category" name="category" value="knowledge" />
  <label for="memory-layer">Layer</label>
  <input id="memory-layer" name="layer" value="current" />
  <label for="memory-tags">Tags</label>
  <input id="memory-tags" name="tags" />
  <button type="submit">Save memory</button>
  <button type="button" id="cancel-edit">Cancel</button>
</form>

<dialog id="delete-dialog" aria-labelledby="delete-title">
  <h2 id="delete-title">Delete memory?</h2>
  <p id="delete-description"></p>
  <label for="delete-confirmation">Type the memory ID to confirm</label>
  <input id="delete-confirmation" autocomplete="off" />
  <button type="button" id="confirm-delete" disabled>Delete permanently</button>
  <button type="button" id="cancel-delete">Cancel</button>
</dialog>
```

Render rows with buttons, not clickable containers. Populate edit with content only because the current update endpoint accepts only `{ content }`. Create requests send `{ content, category, layer, tags }`, splitting comma-separated tags into trimmed non-empty strings. Enable permanent delete only when `requiresDeleteConfirmation` returns true; only its enabled handler sends `DELETE`. Preserve rendered data and announce a generic failure on every unsuccessful operation.

- [ ] **Step 5: Verify green and commit Task 4**

Run: `node --import tsx --test tests/console.test.ts tests/static-docs.test.ts`

Run: `git add static/console.html static/console.mjs tests/console.test.ts`

Run: `git commit -m "feat: add tenant memory management console"`

Expected: helper tests pass and no source file contains a service token, tenant value, or production memory data.

## Task 5: Verify the complete local implementation

**Files:**
- Modify: none expected
- Test: `tests/access.test.ts`, `tests/wrangler-routing.test.ts`, `tests/static-docs.test.ts`, `tests/console.test.ts`, full project suite

**Interfaces:**
- Consumes: Access boundary, protected routes, menu, docs, and console from Tasks 1-4.
- Produces: local evidence that the code is ready for the external Access rollout.

- [ ] **Step 1: Run all focused checks**

Run: `node --import tsx --test tests/access.test.ts tests/wrangler-routing.test.ts tests/static-docs.test.ts tests/console.test.ts`

Expected: zero failures. Confirm missing/rejected tokens are denied, verified assertions reach the route, the guard precedes static/MCP dispatch, root has four actions, and delete cannot be confirmed without its exact memory ID.

- [ ] **Step 2: Regenerate types and run the full local gate**

Run: `npx wrangler types`

Run: `npm run test:all`

Expected: generated bindings include both Access secrets; the project suite, exact tool-surface snapshot, and TypeScript check pass.

- [ ] **Step 3: Inspect complete scope and generated output**

Run: `git diff --check main...HEAD`

Run: `git diff --stat main...HEAD`

Run: `git status --short`

Expected: no whitespace errors; keep pre-existing `.DS_Store` and `docs/superpowers/research/` items unstaged.

- [ ] **Step 4: Commit regenerated types only if Task 1 did not include them**

Run: `git status --short worker-configuration.d.ts`

If it reports a modification, run: `git add worker-configuration.d.ts`

Then run: `git commit -m "chore: regenerate worker access bindings"`

Expected: do not create an empty commit. Skip the commit if generated types are unchanged.

## Task 6: Configure Access and deploy without exposing memory

**Files:**
- Modify: no tracked files expected
- Test: authenticated and unauthenticated production HTTP behavior

**Interfaces:**
- Consumes: the owner-only Cloudflare Access policy, Access team domain, Access application audience, and committed Worker.
- Produces: a production Worker that denies unauthenticated traffic and serves the console only to the owner.

- [ ] **Step 1: Confirm credentials and configure the owner-only Access application**

Run: `npx wrangler whoami`

In Cloudflare Dashboard: **Workers & Pages** → **jamie-mcp-memory** → **Settings** → **Domains & Routes** → **Enable Cloudflare Access** for production `workers.dev`. Select **Manage Cloudflare Access** and create one Allow policy that includes only the owner identity. Copy the application audience tag and Access team domain.

Expected: the Access application has one owner allow rule. Do not add Everyone, country, IP-only, or wildcard-email policies.

- [ ] **Step 2: Set the required Worker secrets without committing values**

Run: `npx wrangler secret put ACCESS_TEAM_DOMAIN`

Run: `npx wrangler secret put ACCESS_AUD`

Paste values only into Wrangler prompts. Do not echo them, write them to `.dev.vars`, or commit them.

Expected: both secrets are configured for `jamie-mcp-memory`.

- [ ] **Step 3: Build the deployment package before publishing**

Run: `npx wrangler deploy --dry-run --outdir /tmp/mcp-memory-access-console-dry-run`

Expected: Wrangler validates required secrets and reads `index.html`, `console.html`, `console.mjs`, and `docs.html` while retaining D1, KV, R2, Vectorize, AI, Durable Object, Assets, and rate-limit bindings.

- [ ] **Step 4: Deploy the committed Worker**

Run: `npx wrangler deploy`

Expected: deployment succeeds without a binding deletion or migration. Record the deployed version ID.

- [ ] **Step 5: Verify production authorization without mutating memory**

Run: `curl --silent --show-error --output /dev/null --write-out "%{http_code}\n" https://jamie-mcp-memory.jamusaaron.workers.dev/`

Expected: `302` to Access or `403`, never `200`.

With the owner browser Access session, verify `/`, `/console`, and `/docs`; enter a known tenant ID and perform only authenticated health/list reads. Confirm the root menu has four choices, console filtering works, and documentation is at `/docs`. Do not create, update, or delete production memories during rollout validation.

- [ ] **Step 6: Preserve MCP access for clients without a browser session**

In Cloudflare Zero Trust: **Access** → **Service Auth** → **Service Tokens**, create a distinct named token per MCP client. Add a Service Auth allow policy for that token to the `jamie-mcp-memory` Access application. Store its ID and secret in the client’s secret store and configure the MCP transport to send `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers.

Expected: service tokens are scoped only to this Access application and never appear in the repository; the browser console remains owner-only.

## Plan Self-Review

- **Spec coverage:** Task 1 creates the fail-closed JWT and secret boundary; Task 2 applies it before static, REST, health, and MCP routes; Task 3 delivers the approved root menu and moved docs; Task 4 implements tenant-scoped management with confirmed deletion; Task 5 validates local code; Task 6 configures and checks the owner-only production boundary and MCP continuity.
- **Placeholder scan:** Every task includes exact files, code contracts, tests, commands, response behavior, commits, and rollout instructions. No deferred implementation markers remain.
- **Type consistency:** `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `AccessJwtVerifier`, `accessMiddleware`, `verifyAccessJwt`, `memoryRoute`, `filterMemories`, and `requiresDeleteConfirmation` are defined before later tasks consume them.
