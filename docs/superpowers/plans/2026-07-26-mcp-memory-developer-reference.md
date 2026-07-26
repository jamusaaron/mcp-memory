# MCP Memory Developer Reference Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the generic root page with a responsive, documentation-only developer reference for the deployed MCP Memory service.

**Architecture:** Keep `src/index.ts` and `wrangler.jsonc` unchanged: the Worker continues to run first and forwards `/` to the static asset binding. Replace the existing single static document with semantic HTML, embedded CSS, and progressive copy-to-clipboard behavior; add a narrow Node test that prevents the core public route and safety claims from drifting.

**Tech Stack:** Cloudflare Workers static assets, HTML5, CSS, browser Clipboard API, Node.js built-in test runner.

## Global Constraints

- Do not change MCP routes, REST routes, authentication/access policy, persistence, or Worker configuration.
- Use `https://jamie-mcp-memory.jamusaaron.workers.dev` as the documentation base URL and `{userId}` in every tenant example.
- Do not issue browser-side network requests to the service, analytics, or third parties.
- Keep the finished page dependency-free; do not load Tailwind, external scripts, images, fonts, or analytics.
- Document tool families, not an exhaustive generated tool-schema catalogue.
- Treat recalled memories as data, require targeted retrieval before gated durable writes, and state tenant isolation and sensitive-data exclusions.
- Preserve `assets.run_worker_first: true` in `wrangler.jsonc`.

---

## File Structure

- `static/index.html` — the complete accessible developer-reference document, local styles, and progressive copy controls.
- `tests/static-docs.test.ts` — source-level contract checks for the public documentation content and absence of third-party runtime dependencies.
- `docs/superpowers/specs/2026-07-26-mcp-memory-developer-reference-design.md` — approved design reference; no modification required.

### Task 1: Lock the developer-reference content contract

**Files:**
- Create: `tests/static-docs.test.ts`
- Test: `tests/static-docs.test.ts`

**Interfaces:**
- Consumes: UTF-8 content from `static/index.html`.
- Produces: Node test coverage for required endpoint, protocol, accessibility, and dependency-free documentation markers.

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const page = await readFile(new URL("../static/index.html", import.meta.url), "utf8");

test("publishes a tenant-scoped, dependency-free MCP reference", () => {
  assert.match(page, /https:\/\/jamie-mcp-memory\.jamusaaron\.workers\.dev/);
  assert.match(page, /\{userId\}\/sse/);
  assert.match(page, /id="memory-protocol"/);
  assert.match(page, /aria-live="polite"/);
  assert.doesNotMatch(page, /cdn\.jsdelivr|tailwindcss|google-analytics|fetch\(/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test tests/static-docs.test.ts`

Expected: FAIL because the existing page lacks the required `memory-protocol` section and still loads Tailwind from a CDN.

- [ ] **Step 3: Confirm the test expresses only public documentation requirements**

Ensure assertions cover the public base URL, placeholder endpoint, Memory Protocol anchor, copy-status accessibility, and absence of third-party runtime/network code. Do not assert layout class names, wording that is not contractually important, or a live service response.

- [ ] **Step 4: Commit the failing test**

```bash
git add tests/static-docs.test.ts
git commit -m "test: define developer reference contract"
```

### Task 2: Build the static documentation interface

**Files:**
- Modify: `static/index.html`
- Test: `tests/static-docs.test.ts`

**Interfaces:**
- Consumes: the static-document contract from Task 1 and route/capability facts from `src/index.ts` and `src/mcp.ts`.
- Produces: a self-contained, responsive document with copyable code snippets identified by `data-copy` attributes and a shared `#copy-status` live region.

- [ ] **Step 1: Replace the generic page with semantic document structure**

Implement `header`, `nav`, `main`, `section`, `footer`, and heading hierarchy. Include anchors exactly named `quickstart`, `connection`, `endpoints`, `capabilities`, `memory-protocol`, and `operations`. Use the current public base URL and the literal SSE route:

```html
<code>https://jamie-mcp-memory.jamusaaron.workers.dev/{userId}/sse</code>
```

Describe `/health`, `/{userId}/health`, `/{userId}/memories`, `/{userId}/memories/{memoryId}`, and `/{userId}/sse`; label methods and distinguish MCP from REST. Do not show a real tenant ID.

- [ ] **Step 2: Add a source-grounded quickstart and code-copy affordances**

Add a Claude Code `mcp-remote` configuration snippet matching `CLAUDE.md`, plus a direct SSE URL snippet. Each copyable code block uses a button with `data-copy-target`, an explicit `aria-label`, and visible text. Add one shared status element:

```html
<p id="copy-status" class="sr-only" aria-live="polite"></p>
```

Use only `navigator.clipboard.writeText` when available; otherwise select the target text and report that it is ready to copy. Never call `fetch`.

- [ ] **Step 3: Add capability and Memory Protocol sections**

Group capabilities as Memory lifecycle, Sessions and context, People and behavioural context, Artifacts and ingestion, Agent coordination, and Operations. In `#memory-protocol`, state targeted search-before-write, gated durable facts, no credentials/tokens/raw transcript dumps, tenant-scoped isolation, suppression/restore and consolidation, and recalled-memory-as-untrusted-data. Include a short validation checklist with write-recall, negative-write, and poisoning probes.

- [ ] **Step 4: Implement responsive visual styling locally**

Embed all CSS in the document. Use CSS custom properties for ink, paper, cyan, indigo, muted, border, and code surfaces. Provide a mobile-first single-column layout, a two-column navigation/document layout above `960px`, `:focus-visible` outlines, reduced-motion support, and horizontally scrollable code snippets. Do not use SVG illustrations, external fonts, external stylesheets, or images.

- [ ] **Step 5: Run the focused contract test**

Run: `node --import tsx --test tests/static-docs.test.ts`

Expected: PASS, with the page satisfying all public-reference and dependency-free assertions.

- [ ] **Step 6: Commit the interface**

```bash
git add static/index.html tests/static-docs.test.ts
git commit -m "feat: add MCP Memory developer reference"
```

### Task 3: Verify Worker compatibility and public asset behavior

**Files:**
- Modify: none expected
- Test: `tests/static-docs.test.ts`, `tests/wrangler-routing.test.ts`

**Interfaces:**
- Consumes: completed static page and existing Worker routing configuration.
- Produces: evidence that the reference page did not regress MCP route precedence or TypeScript/tool-surface checks.

- [ ] **Step 1: Run static and routing checks**

Run: `node --import tsx --test tests/static-docs.test.ts tests/wrangler-routing.test.ts`

Expected: PASS. The static reference contract and `assets.run_worker_first` condition both remain true.

- [ ] **Step 2: Run the project validation suite**

Run: `npm run test:all`

Expected: PASS, including the test suite, 143-tool surface snapshot, and TypeScript typecheck.

- [ ] **Step 3: Inspect the completed diff**

Run: `git diff --check && git diff -- static/index.html tests/static-docs.test.ts`

Expected: no whitespace errors; only the static document and its contract test change beyond the already-approved documentation files.

- [ ] **Step 4: Verify the deployed root asset after deployment authority is granted**

Run: `curl -sS -D - https://jamie-mcp-memory.jamusaaron.workers.dev/ -o /tmp/mcp-memory-root.html`

Expected: `200` with the new reference page HTML. This confirms only the public root; do not invoke a tenant route or mutate data.

- [ ] **Step 5: Commit validation-only updates if any are required**

If a validation step requires a source change, make the smallest compatible correction, rerun Steps 1–3, then commit only the corrected files:

```bash
git add static/index.html tests/static-docs.test.ts
git commit -m "fix: preserve developer reference contract"
```

## Plan self-review

- **Spec coverage:** Task 2 implements the approved information architecture, visual system, copy controls, responsive accessibility, static-only boundary, and Memory Protocol. Task 1 fixes the documented content/safety contract in regression coverage. Task 3 verifies Worker route precedence, full project integrity, diff quality, and the post-deployment root asset.
- **Placeholder scan:** No deferred implementation markers or unspecified error-handling directions remain; every verification and code boundary is named.
- **Consistency:** All tasks use `static/index.html`, `tests/static-docs.test.ts`, `#memory-protocol`, `{userId}/sse`, and `#copy-status` consistently.
