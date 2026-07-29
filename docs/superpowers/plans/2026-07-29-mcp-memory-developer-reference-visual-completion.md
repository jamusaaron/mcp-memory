# MCP Memory Developer Reference Visual Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the static MCP Memory developer reference with its approved dark, high-contrast technical visual system and visible copy feedback.

**Architecture:** Keep the Worker and asset routing unchanged: `src/index.ts` continues to send `/` to the static asset binding. Update the self-contained `static/index.html` visual tokens and existing progressive copy script, with source-level tests protecting the dark/static/no-network contract; correct the stale `CLAUDE.md` description in the same implementation task.

**Tech Stack:** Cloudflare Workers static assets, semantic HTML5, embedded CSS, browser Clipboard API, Node.js built-in test runner, TypeScript/tsx, Wrangler.

## Global Constraints

- Preserve the existing documentation-only page structure, route facts, safety framing, council decision boundary, and `{userId}` placeholder examples.
- Do not change Worker routes, MCP tools, persistence, authentication, Access policy, or `wrangler.jsonc` asset routing.
- Keep the page dependency-free: no external fonts, image assets, icon library, analytics, client storage, or browser-side calls to Worker, MCP, REST, health, or third-party services.
- Use `color-scheme: dark` with a deep blue-black canvas, off-white content text, cyan and indigo signals, high-contrast code panels, and the existing warm keyboard-focus color.
- Keep semantic landmarks, heading order, skip navigation, responsive mobile-to-sticky-rail layout, and `prefers-reduced-motion` support intact.
- Each copy action must visibly report `Copied`, `Selected — copy manually`, or `Unavailable`, reset to its original label, and retain the shared polite live-region announcement.
- Deploy validation must inspect only the public Worker root; do not invoke tenant routes or mutate tenant data.

---

## File Structure

- `static/index.html` — the complete dependency-free developer reference: local visual tokens, responsive style rules, two copy controls, and progressive clipboard behavior.
- `tests/static-docs.test.ts` — source-level regression contract for tenant-safe docs, no-network/dependency-free constraints, dark visual markers, visible copy feedback, and the maintained documentation description.
- `CLAUDE.md` — repository map entry describing the static page as a developer reference rather than a memory-management UI.
- `docs/superpowers/specs/2026-07-29-mcp-memory-developer-reference-visual-completion-design.md` — approved design source; no implementation changes required.

### Task 1: Define the dark reference and visible-feedback contract

**Files:**
- Modify: `tests/static-docs.test.ts:1-36`
- Test: `tests/static-docs.test.ts`

**Interfaces:**
- Consumes: UTF-8 contents of `static/index.html` and `CLAUDE.md`.
- Produces: regression checks that require the selected dark palette, per-button feedback state, zero browser-side network dependencies, and an accurate repository-map entry.

- [ ] **Step 1: Write the failing page-and-documentation test**

Append this test after the existing workflow contract test. Keep the existing two tests unchanged.

~~~ts
test("uses the selected dark reference system and visible copy feedback", async () => {
  const [page, claude] = await Promise.all([
    readFile(new URL("../static/index.html", import.meta.url), "utf8"),
    readFile(new URL("../CLAUDE.md", import.meta.url), "utf8"),
  ]);

  assert.match(page, /color-scheme:\s*dark/);
  assert.match(page, /--paper:\s*#070b17/);
  assert.match(page, /--surface:\s*#0e1628/);
  assert.match(page, /\.copy-button\[data-copy-state\]/);
  assert.match(page, /data-copy-label/);
  assert.match(page, /Copied/);
  assert.match(page, /Selected — copy manually/);
  assert.match(page, /Unavailable/);
  assert.match(page, /window\.setTimeout/);
  assert.doesNotMatch(page, /fetch\(/i);

  assert.match(claude, /static\/index\.html` — Static developer reference/);
  assert.doesNotMatch(claude, /Web UI for managing memories/);
});
~~~

- [ ] **Step 2: Run the focused contract test and confirm the expected red state**

Run:

~~~bash
node --import tsx --test tests/static-docs.test.ts
~~~

Expected: FAIL in `uses the selected dark reference system and visible copy feedback` because the page still declares `color-scheme: light`, has no `data-copy-state` visual rule, and `CLAUDE.md` still describes a memory-management UI. The two existing tests must continue to pass.

- [ ] **Step 3: Commit only the failing regression contract and the approved planning record**

Run:

~~~bash
git add tests/static-docs.test.ts docs/superpowers/specs/2026-07-29-mcp-memory-developer-reference-visual-completion-design.md docs/superpowers/plans/2026-07-29-mcp-memory-developer-reference-visual-completion.md
git commit -m "test: define dark developer reference contract"
~~~

Expected: the commit contains only the new test and approved design/plan files; it must not stage `.DS_Store` or the pre-existing `docs/superpowers/research/` directory.

### Task 2: Apply the dark visual system and copy-feedback behavior

**Files:**
- Modify: `static/index.html:12-642,696-703,751-758,1114-1163`
- Modify: `CLAUDE.md:46`
- Test: `tests/static-docs.test.ts`

**Interfaces:**
- Consumes: the contract from Task 1 and the existing `data-copy-target` selectors (`#claude-code-config` and `#direct-sse-url`).
- Produces: a dependency-free dark document surface and a `setCopyFeedback(button, label, state, message)` helper that updates visible button text, `data-copy-state`, and the shared `#copy-status` live region.

- [ ] **Step 1: Replace the root visual tokens and all light-only component values**

At the existing `:root` declaration, replace the light system with this exact base palette. Reuse these variables throughout the existing component rules rather than introducing external assets or a second stylesheet.

~~~css
:root {
  color-scheme: dark;
  --ink: #f4f7fb;
  --paper: #070b17;
  --surface: #0e1628;
  --surface-raised: #14213a;
  --cyan: #57e2eb;
  --indigo: #a5a0ff;
  --muted: #a9b7cf;
  --border: #2c3b54;
  --code: #050a14;
  --code-ink: #eaf2ff;
  --soft-cyan: #092b36;
  --soft-indigo: #1a1c46;
  --focus: #fbbf24;
  --shadow: 0 20px 52px rgb(0 0 0 / 35%);
}
~~~

Update the existing header, navigation, sections, callouts, inline code, endpoint rows, badges, checklist cards, footer, and copy-button hover rules to use `--paper`, `--surface`, `--surface-raised`, `--border`, `--ink`, `--muted`, `--soft-cyan`, and `--soft-indigo`. Remove the existing light-only literal colors (`#f7f9fc`, `#ffffff`, `#fbfcfe`, `#f2f5fa`, `#e8fbfc`, and `#eef0ff`) from the document stylesheet. Preserve the current media queries, dimensions, semantic markup, and reduced-motion rule.

- [ ] **Step 2: Add a visible feedback style and stable original labels**

Add a `data-copy-label` attribute to both existing buttons and retain their current visible labels:

~~~html
<button
  class="copy-button"
  type="button"
  data-copy-label="Copy config"
  data-copy-target="#claude-code-config"
  aria-label="Copy Claude Code MCP configuration"
>
  Copy config
</button>
~~~

Use `data-copy-label="Copy URL"` for the direct SSE button. Add this style near `.copy-button` so button state is visible without moving or exposing the screen-reader-only live region:

~~~css
.copy-button[data-copy-state] {
  border-color: var(--cyan);
  background: var(--soft-cyan);
  color: var(--ink);
}

.copy-button[data-copy-state="fallback"] {
  border-color: var(--focus);
}

.copy-button[data-copy-state="unavailable"] {
  border-color: #fb7185;
  background: #3a1523;
}
~~~

- [ ] **Step 3: Replace the current reporting helper with shared visual feedback**

Keep `selectTarget` and the `#copy-status` live region. Replace the current `report` function with this helper, which creates a visible, resettable per-button state and preserves the accessible message:

~~~js
const setCopyFeedback = (button, label, state, message) => {
  window.clearTimeout(Number(button.dataset.copyReset));
  button.textContent = label;
  button.dataset.copyState = state;
  status.textContent = "";
  window.requestAnimationFrame(() => {
    status.textContent = message;
  });
  button.dataset.copyReset = String(
    window.setTimeout(() => {
      button.textContent = button.dataset.copyLabel;
      button.removeAttribute("data-copy-state");
      button.removeAttribute("data-copy-reset");
    }, 2400),
  );
};
~~~

In the click listener, call the helper with the following exact outcomes:

~~~js
if (!target) {
  setCopyFeedback(button, "Unavailable", "unavailable", "Copy target is unavailable.");
  return;
}

// successful navigator.clipboard.writeText(text)
setCopyFeedback(button, "Copied", "success", "Copied to clipboard.");

// clipboard exception or unavailable Clipboard API after selectTarget(target)
setCopyFeedback(button, "Selected — copy manually", "fallback", "Text selected and ready to copy.");
~~~

Do not add `fetch`, local storage, cookies, event tracking, or a service call. Do not make the code snippet itself mutable.

- [ ] **Step 4: Correct the repository-map description**

Replace `CLAUDE.md` line 46 with exactly:

~~~md
- `static/index.html` — Static developer reference for connecting to the tenant-scoped MCP Memory service
~~~

- [ ] **Step 5: Run the focused contract test and confirm the green state**

Run:

~~~bash
node --import tsx --test tests/static-docs.test.ts
~~~

Expected: PASS. The page retains the existing tenant/MCP/council checks and now passes the dark-palette, visible-feedback, no-network, and `CLAUDE.md` assertions.

- [ ] **Step 6: Inspect only the intended implementation diff**

Run:

~~~bash
git diff --check
git diff -- static/index.html CLAUDE.md tests/static-docs.test.ts
~~~

Expected: no whitespace errors; the diff contains no Worker route, dependency, tenant-route, or configuration changes.

- [ ] **Step 7: Commit the completed static interface**

Run:

~~~bash
git add static/index.html CLAUDE.md tests/static-docs.test.ts
git commit -m "feat: complete dark developer reference interface"
~~~

Expected: the commit contains only the static document, its contract test, and the repository-map correction.

### Task 3: Run Worker and public-root validation

**Files:**
- Modify: none expected
- Test: `tests/static-docs.test.ts`, `tests/wrangler-routing.test.ts`, full project suite

**Interfaces:**
- Consumes: the committed static asset and unchanged `assets.run_worker_first` configuration.
- Produces: evidence that the UI remains static, does not mask tenant-scoped MCP routes, and the public root serves the completed dark page after deployment.

- [ ] **Step 1: Run focused static and route-precedence tests**

Run:

~~~bash
node --import tsx --test tests/static-docs.test.ts tests/wrangler-routing.test.ts
~~~

Expected: PASS. The static documentation contract and the `run_worker_first` routing guard both succeed.

- [ ] **Step 2: Run the complete local gate**

Run:

~~~bash
npm run test:all
~~~

Expected: PASS, including the project test suite, exact tool-surface snapshot, and TypeScript typecheck.

- [ ] **Step 3: Build a Worker deployment dry run**

Run:

~~~bash
npx wrangler deploy --dry-run --outdir /tmp/mcp-memory-developer-reference-visual-dry-run
~~~

Expected: PASS and list `static/index.html` as a deployable asset without a route or binding change.

- [ ] **Step 4: Deploy the already-committed Worker and verify only the public root**

Run:

~~~bash
npm run deploy
curl -fsS https://jamie-mcp-memory.jamusaaron.workers.dev/ -o /tmp/mcp-memory-developer-reference-live.html
rg -n "color-scheme: dark|data-copy-label=\"Copy config\"|MCP Memory · Developer reference" /tmp/mcp-memory-developer-reference-live.html
~~~

Expected: deployment succeeds; the public root returns the completed reference markup containing all three markers. Do not request a tenant SSE route or perform a memory write/read during this UI-only validation.

- [ ] **Step 5: Record final repository state without creating an empty commit**

Run:

~~~bash
git status --short
git log --oneline -2
~~~

Expected: the two planned commits are the latest relevant commits, while pre-existing untracked `.DS_Store` and `docs/superpowers/research/` files remain unstaged and untouched.

## Plan self-review

- **Spec coverage:** Task 1 guards the selected visual, feedback, static/no-network, and documentation requirements. Task 2 implements the dark visual system, visible accessible copy feedback, responsive preservation, and stale-document correction. Task 3 verifies routing, the complete local project, deployability, the public root, and repository scope.
- **Placeholder scan:** No deferred implementation markers or generic validation directions remain; every test, CSS token, feedback label, command, file, and commit scope is explicit.
- **Consistency:** `--paper: #070b17`, `--surface: #0e1628`, `data-copy-label`, `data-copy-state`, `setCopyFeedback`, the three feedback labels, `{userId}`, and the public-root-only verification scope are used consistently throughout.
