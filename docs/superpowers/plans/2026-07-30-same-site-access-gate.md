# Same-Site Access Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the private MCP Memory console usable in Safari without Cloudflare Access redirects while preserving authentication on every Worker route.

**Architecture:** Add a Worker-owned access module that validates a private key and issues a signed, secure same-site session cookie. The Hono app allows only login/session/logout endpoints before this gate; all other browser requests redirect to login while API and MCP callers can use the private key in an Authorization Bearer header.

**Tech Stack:** TypeScript, Hono, Web Crypto, Node test runner, Cloudflare Workers secrets and Access policies.

## Global Constraints

- The private key is a Worker secret named `APP_ACCESS_KEY`; never write it to the repository or logs.
- Reuse `COOKIE_ENCRYPTION_KEY` only to sign opaque session payloads; never put the access key in a cookie.
- Cookie attributes are `__Host-mcp-memory`, `Secure`, `HttpOnly`, `SameSite=Strict`, and `Path=/`.
- Protect static assets, REST, health, and MCP dispatch routes.
- Switch Cloudflare Access to bypass only after the authenticated Worker version is deployed.

---

### Task 1: Implement and test opaque signed sessions

**Files:**
- Create: `src/app-access.ts`
- Create: `tests/app-access.test.ts`

**Interfaces:**
- Produces: `appAccessMiddleware()` and `createSessionToken()` for the Hono app.
- Consumes: `Env.APP_ACCESS_KEY` and `Env.COOKIE_ENCRYPTION_KEY`.

- [ ] **Step 1: Write the failing test**

```ts
test("accepts a session signed with the configured key", async () => {
  const token = await createSessionToken("cookie-secret", 1_800_000_000);
  assert.equal(await verifySessionToken(token, "cookie-secret", 1_700_000_000), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/app-access.test.ts`

Expected: FAIL because `src/app-access.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
export async function createSessionToken(secret: string, expiresAt: number): Promise<string> {
  const payload = String(expiresAt);
  return `${payload}.${await sign(payload, secret)}`;
}
```

Implement HMAC signing, fixed-length key comparison, cookie parsing, and the middleware around this interface.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/app-access.test.ts`

Expected: PASS, including missing, expired, and tampered token rejection plus Bearer key acceptance.

- [ ] **Step 5: Commit**

```bash
git add src/app-access.ts tests/app-access.test.ts
git commit -m "feat: add same-site access sessions"
```

### Task 2: Gate the Worker routes and login page

**Files:**
- Create: `static/login.html`
- Modify: `src/app.ts`
- Modify: `wrangler.jsonc`
- Modify: `tests/wrangler-routing.test.ts`

**Interfaces:**
- Consumes: `appAccessMiddleware()` from `src/app-access.ts`.
- Produces: `/auth/login`, `/auth/session`, and `/auth/logout` routes.

- [ ] **Step 1: Write the failing test**

```ts
test("redirects an unauthenticated console navigation to the Worker login route", async () => {
  const response = await app.fetch(new Request("https://example.test/console", {
    headers: { Accept: "text/html" },
  }), env, ctx);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/auth/login?next=%2Fconsole");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/wrangler-routing.test.ts`

Expected: FAIL because unauthenticated routes still return the Access-specific response.

- [ ] **Step 3: Write minimal implementation**

Replace `accessMiddleware()` with `appAccessMiddleware()`, serve the inline-key login page through `ASSETS`, create a session cookie after key verification, and clear it on logout. Require `APP_ACCESS_KEY` in Wrangler configuration and retain `assets.run_worker_first: true`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/wrangler-routing.test.ts tests/app-access.test.ts`

Expected: PASS; unauthenticated REST/MCP receives 401 and no asset/MCP dispatch occurs before authentication.

- [ ] **Step 5: Commit**

```bash
git add static/login.html src/app.ts wrangler.jsonc tests/wrangler-routing.test.ts
git commit -m "feat: gate Worker routes with private sessions"
```

### Task 3: Deploy the Worker gate and retire the redirecting edge login

**Files:**
- Modify: Cloudflare Worker secret `APP_ACCESS_KEY`
- Modify: Cloudflare Access policy for `jamie-mcp-memory - Production`

**Interfaces:**
- Consumes: deployed Worker access middleware.
- Produces: a browser-safe private console URL and Bearer access for MCP/API clients.

- [ ] **Step 1: Set the secret without exposing it in source control**

Run: `npx wrangler secret put APP_ACCESS_KEY`

Expected: secret is stored only in Cloudflare.

- [ ] **Step 2: Deploy and inspect the new Worker version**

Run: `npx wrangler deploy && npx wrangler versions list`

Expected: production version lists `APP_ACCESS_KEY` and static login asset.

- [ ] **Step 3: Change the exact production Access policy to bypass**

Use the Access API to update only the `jamie-mcp-memory - Production` policy to a bypass rule. The Worker already enforces authentication at this point.

- [ ] **Step 4: Verify production behavior**

Run: `curl -I https://jamie-mcp-memory.jamusaaron.workers.dev/console`

Expected: `302 Location: /auth/login?next=%2Fconsole`, never a `cloudflareaccess.com` location. Verify a valid session reaches the console and invalid Bearer token receives `401`.

- [ ] **Step 5: Commit deployment support changes**

```bash
git add wrangler.jsonc static/login.html src/app.ts src/app-access.ts tests
git commit -m "fix: replace Access redirect with same-site login"
```
