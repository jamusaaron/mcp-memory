# Trusted Second-Brain Artifact Release

## Authority boundary

Local verification and `wrangler deploy --dry-run` do not authorize production deployment, Git push, or Cloudflare Access changes. Production commands may run only from a clean detached worktree at an explicitly recorded commit SHA; never deploy the caller's dirty working directory. Stop before deploy until the user explicitly approves it.

The approval must separately and explicitly cover both the Worker deployment and
the additive D1 schema activation below. Schema activation never drops or
rewrites legacy tables, but it is a production database mutation and is not
implied by approval to run local verification.

### Known hazard: uncommitted production code

Production has previously been deployed from a dirty working tree. Before any
release, confirm that everything production depends on is actually committed:

```bash
git status --short
git grep -c "requireGeneratedText" HEAD -- src/utils/ai.ts
git grep -c "run_worker_first" HEAD -- wrangler.jsonc
```

Both greps must return a non-zero count. If either returns `0`, the Workers AI
empty-generation guard or worker-first asset routing exists only in the working
tree, and deploying a committed SHA would silently remove it. `llmCall` would
return `""` instead of throwing, and an empty generation can overwrite
`living_summary`, `self_profile`, and `personality`. Commit those changes and
re-run the gates before proceeding.

## Pre-deploy evidence

Choose the exact reviewed commit intended for production. It must contain every
required prerequisite; uncommitted changes are never part of a release:

```bash
export RELEASE_SHA="<reviewed-full-commit-sha>"
export RELEASE_DIR="/tmp/mcp-memory-release-${RELEASE_SHA}"
git worktree add --detach "$RELEASE_DIR" "$RELEASE_SHA"
cd "$RELEASE_DIR"
test "$(git rev-parse HEAD)" = "$RELEASE_SHA"
test -z "$(git status --porcelain)"
npm ci
```

From that clean detached worktree:

1. `npm run test:all`
2. `npx wrangler types --check`
3. Scoped `npx biome check` over the artifact release files
4. `npx wrangler deploy --dry-run --outdir /tmp/mcp-memory-trusted-artifacts-dry-run`
5. `npx wrangler whoami`
6. `npx wrangler deployments status`

Require the deployment status to show exactly one active version at 100%
traffic. Stop for an explicit rollout decision if production is already split
across versions. Record that sole active version in the shell before deploying:

```bash
: "${PREVIOUS_VERSION_ID:?set PREVIOUS_VERSION_ID to the sole 100% production version shown by deployments status}"
```

### Known pre-existing gate deviation

The scoped Biome check does not currently exit 0. This is inherited style debt
from the earlier artifact tasks, not a regression: the same check at baseline
`4a5a8a1` already reports errors in files the later tasks never touched
(`schema.ts`, `migrations.ts`, `types.ts`, `kv.ts`, `artifact-synthesis.ts`,
`tests/helpers/sqlite-d1.ts`). Two `noControlCharactersInRegex` findings in
`profile-facts.ts` are intentional — that regex deliberately rejects control
characters. Treat Biome as advisory for this release and gate on
`npm run test:all` plus the Wrangler dry run. Do not run `biome format --write`
across a dirty worktree to force it green.

## Deploy only after explicit approval

```bash
cd "$RELEASE_DIR"
test "$(git rev-parse HEAD)" = "$RELEASE_SHA"
test -z "$(git status --porcelain)"
npx wrangler deploy --message "Release trusted second-brain artifacts"
```

Record the release SHA and new version ID from Wrangler output. Do not alter
Access policy to make the probe pass.

## Activate the bounded additive schema

Do not begin acceptance while the database is between migration steps. Using the
same authenticated MCP client intended for acceptance, issue MCP initialization
against `/{userId}/sse`. A `503` JSON response whose exact safe error is
`Database upgrade in progress` means that invocation completed at most one
bounded bootstrap/migration step and intentionally performed no MCP or
maintenance work.

Retry sequentially, never concurrently, up to
`DATABASE_MIGRATIONS.length + 2` attempts. Stop immediately on any other error,
HTML, redirect, timeout, or exhausted attempt bound. The first successful MCP
initialization proves a later invocation performed the two-statement stable
ledger check; only then continue. Do not change Access policy to reach this
route. Record only migration version/count metadata from content-free Worker
logs — never request headers, tokens, tenant IDs, memory text, or generated
content.

## Live MCP acceptance

Use an authenticated MCP client against the deployed `/{userId}/sse` endpoint. A connected SSE stream by itself is not acceptance.

1. Initialize MCP and complete a real request through the companion message route.
2. Call `tools/list`; compare the sorted names to `EXPECTED_TOOL_NAMES` in `scripts/check-tool-surface.mjs` and require exactly 143.
3. Write a uniquely marked identity memory, call `rebuild_living_summary`, and record its artifact ID and version.
4. Start a new session with `get_session_brief`; require the published living summary and its freshness label.
5. Call `update_profile` without `person_id`, rebuild the self profile, and record the candidate ID.
6. Start another session; require that candidate text is absent.
7. Approve the candidate with `review_derived_artifact`, start a new session, and require the approved text.
8. Record a behavioural observation, call `behavioral_model` with `rebuild=true`, and require a candidate rather than automatic publication.
9. Approve that candidate and require it in the next session brief.
10. Create a second living-summary version, restore the first with `restore_derived_artifact`, and require a new higher version rather than a rewritten historical row.
11. Forget the uniquely marked cited memory, call `get_derived_artifact` for every affected version, and require tombstoned audit metadata with no claims or rendered text.
12. Require the affected artifact to be absent from a new session brief; manually rebuild the living summary from remaining evidence and require a newly published replacement.
13. Attempt list, get, review, and restore from a second tenant; require no cross-tenant artifact visibility or mutation.

Stop and roll back if schema activation exceeds its bounded attempts, the
endpoint returns HTML, redirects to `cloudflareaccess.com`, omits the companion
route, advertises a non-143 tool set, returns an output-schema error, publishes
uncited content, exposes a candidate in session context, revives deleted
evidence, or permits cross-tenant access.

## Rollback

Worker code rollback is safe because the release migrations are additive. Do not reverse or delete D1 tables.

```bash
: "${PREVIOUS_VERSION_ID:?set PREVIOUS_VERSION_ID before rollback}"
cd "$RELEASE_DIR"
test "$(git rev-parse HEAD)" = "$RELEASE_SHA"
test -z "$(git status --porcelain)"
npx wrangler rollback "$PREVIOUS_VERSION_ID"
```

After rollback, repeat MCP initialization, the companion-route request, and `tools/list`. Report the failed acceptance step and captured reason code without copying memory text, generated claims, prompts, credentials, signed URLs, or Access tokens into logs.
