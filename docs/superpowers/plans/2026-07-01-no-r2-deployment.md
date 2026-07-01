# No-R2 MCP Memory Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish and deploy a 97-tool MCP Memory server that has no Cloudflare R2 subscription dependency.

**Architecture:** Keep the merged PR #2 Worker architecture intact while removing R2-backed tool registration and the runtime R2 binding. Enforce the reduced surface with a static contract check, then verify the deployed endpoint through MCP before updating Claude Desktop.

**Tech Stack:** TypeScript, Node.js, Cloudflare Workers, D1, KV, Vectorize, Workers AI, Durable Objects, MCP SDK.

## Global Constraints

- Advertise exactly 97 tools.
- Do not advertise the eight R2-dependent tool names listed in the approved design.
- Do not declare `r2_buckets` in `wrangler.jsonc`.
- Preserve all non-R2 tool registrations and Cloudflare bindings.
- Do not update Claude Desktop until the deployed endpoint passes live MCP inventory verification.

---

### Task 1: Add a failing tool-surface contract check

**Files:**
- Create: `scripts/check-tool-surface.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: active tool registration source files and `wrangler.jsonc`.
- Produces: `npm run test:surface`, exiting zero only for the approved 97-tool surface.

- [ ] **Step 1: Create the contract checker**

```js
import fs from "node:fs";
import path from "node:path";

const activeFiles = [
  "src/tools/memory.ts",
  "src/tools/people.ts",
  "src/tools/uncertainty.ts",
  "src/tools/session.ts",
  "src/tools/behavioral.ts",
  "src/tools/ingestion.ts",
  "src/tools/ai-agents.ts",
  "src/tools/health.ts",
  "src/tools/infra.ts",
];
const forbidden = new Set([
  "read_static_file", "update_static_file", "delete_static_file", "list_static_files",
  "r2_bucket_create", "r2_bucket_get", "r2_bucket_delete", "r2_buckets_list",
]);
const names = activeFiles.flatMap((file) => {
  const source = fs.readFileSync(path.resolve(file), "utf8");
  return [...source.matchAll(/server\.tool\(\s*["']([^"']+)["']/g)].map((match) => match[1]);
});
const errors = [];
for (const name of forbidden) if (names.includes(name)) errors.push(`forbidden tool registered: ${name}`);
if (names.length !== 97) errors.push(`expected 97 tools, found ${names.length}`);
if (new Set(names).size !== names.length) errors.push("duplicate tool names detected");
const mcpSource = fs.readFileSync("src/mcp.ts", "utf8");
if (mcpSource.includes("registerStaticFileTools")) errors.push("static-file tools remain registered");
const wrangler = fs.readFileSync("wrangler.jsonc", "utf8");
if (/"r2_buckets"\s*:/.test(wrangler)) errors.push("R2 binding remains configured");
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`Tool surface verified: ${names.length} tools, no R2 dependency`);
```

- [ ] **Step 2: Add the package script**

Add `"test:surface": "node scripts/check-tool-surface.mjs"` under `scripts` in `package.json`.

- [ ] **Step 3: Run the checker and confirm RED**

Run: `npm run test:surface`  
Expected: non-zero exit reporting the four `r2_bucket_*` registrations, the static registration, the R2 binding, and `expected 97 tools, found 101`.

### Task 2: Remove R2 from the active surface

**Files:**
- Modify: `src/mcp.ts`
- Modify: `src/tools/infra.ts`
- Modify: `wrangler.jsonc`
- Modify: `README.md`

**Interfaces:**
- Consumes: the existing PR #2 tool registries.
- Produces: a Worker with 97 registered tools and no runtime R2 binding.

- [ ] **Step 1: Disable static-file registration**

Remove the `registerStaticFileTools` import and invocation from `src/mcp.ts`.

- [ ] **Step 2: Remove R2 infrastructure registrations**

Delete the `// ── R2 ──` section in `src/tools/infra.ts`, from `r2_bucket_create` through `r2_buckets_list`.

- [ ] **Step 3: Remove the R2 binding**

Delete the complete `r2_buckets` array from `wrangler.jsonc`.

- [ ] **Step 4: Document the reduced deployment**

Update `README.md` to state that this fork's default deployment exposes 97 tools and excludes the four static-file and four R2 infrastructure tools so no R2 subscription is required. Remove R2 from the required-service and architecture lists.

- [ ] **Step 5: Run the contract checker and confirm GREEN**

Run: `npm run test:surface`  
Expected: `Tool surface verified: 97 tools, no R2 dependency`.

- [ ] **Step 6: Install locked dependencies without package lifecycle scripts**

Run: `npm ci --ignore-scripts`  
Expected: exit 0. This installs the lockfile without executing third-party install scripts.

- [ ] **Step 7: Run static verification**

Run: `npx tsc --noEmit`  
Expected: exit 0 with no TypeScript errors.

- [ ] **Step 8: Commit the implementation**

```bash
git add scripts/check-tool-surface.mjs package.json src/mcp.ts src/tools/infra.ts wrangler.jsonc README.md
git commit -m "feat: deploy MCP memory without R2"
```

### Task 3: Publish, deploy, and replace Claude's connector

**Files:**
- Modify: `~/Library/Application Support/Claude/claude_desktop_config.json`

**Interfaces:**
- Consumes: verified repository and Cloudflare dashboard deployment flow.
- Produces: a live 97-tool endpoint configured in Claude Desktop.

- [ ] **Step 1: Push the verified commits**

Run: `git push origin main`  
Expected: remote `main` advances to the local implementation commit.

- [ ] **Step 2: Deploy through Cloudflare**

Use the existing deploy-to-Workers flow for `https://github.com/jamusaaron/mcp-memory`. Create/select KV, D1, and Vectorize resources; set Vectorize dimensions to `1024` and metric to `cosine`; leave R2 absent; deploy.

- [ ] **Step 3: Verify the remote endpoint**

Run the local MCP verifier against `https://<worker-host>/<generated-user-id>/sse`.  
Expected: 97 tools, with none of the eight forbidden R2-dependent names.

- [ ] **Step 4: Update Claude Desktop**

Replace only the `mcp-memory` endpoint URL in `claude_desktop_config.json`, preserving all unrelated settings.

- [ ] **Step 5: Restart and verify Claude Desktop**

Quit and relaunch Claude Desktop. Confirm the new `mcp-remote` process is a child of the new Claude process and rerun the MCP tool inventory check against the configured URL.
