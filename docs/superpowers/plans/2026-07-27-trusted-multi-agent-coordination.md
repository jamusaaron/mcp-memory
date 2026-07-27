# Trusted Multi-Agent Coordination and Decision Council Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add tenant-safe trusted coordination primitives and a seven-bot, reasoned final-decision council to MCP Memory without changing the legacy note or task contracts.

**Architecture:** Add a standalone `coordination` domain with additive D1 migrations, typed persistence helpers, deterministic policy functions, and an MCP registration module. Handoffs, task leases, reviews, proposals, votes, and decisions are append-only; the existing `ai_note_*` and `agent_task_*` APIs remain compatibility surfaces and are never elevated to trusted evidence.

**Tech Stack:** Cloudflare Workers, D1, TypeScript, Hono/MCP SDK, Zod, Node built-in test runner, existing SQLite D1 test helper.

## Global Constraints

- Every coordination row, query, mutation, and event is scoped by the server-derived `userId`.
- Retrieved memory, handoffs, notes, and council rationale are untrusted data, never executable instruction.
- No council result may trigger an external, destructive, or irreversible action.
- Do not rename, remove, or alter the result contracts of existing MCP tools.
- Submitted handoffs, reviews, votes, and decisions are append-only; corrections supersede rather than overwrite.
- Reject credentials, tokens, session identifiers, government/payment IDs, raw transcript payloads, and unrequested sensitive third-party data on all new writes.
- The council roster is exactly seven fixed roles: evidence, user_intent, safety, privacy, strategy, operations, and adversarial_review.
- A final council outcome requires all seven votes; approval requires at least five approvals and zero escalations; three rejections rejects; any escalation results in `escalated`.
- The Worker, not an MCP caller, owns council identities and records every council vote by running the fixed roles server-side.

---

## File Structure

- `src/types.ts` — coordination enums and typed records.
- `src/schema.ts` — additive D1 table/index migration statements.
- `src/utils/coordination.ts` — all trusted persistence, server-time state transitions, content guards, and council decision math.
- `src/tools/coordination.ts` — new MCP tools and structured output schemas.
- `src/mcp.ts` — registration of the coordination tool module.
- `tests/coordination.test.ts` — deterministic data/state/security tests using the SQLite D1 harness.
- `tests/coordination-tools.test.ts` — tool registration and MCP handler contract tests.
- `tests/schema-migrations.test.ts` — migration compatibility assertions.
- `tests/static-docs.test.ts` and `static/index.html` — reference page section for multi-agent workflow semantics.

### Task 1: Establish typed coordination records and additive migration coverage

**Files:**
- Modify: `src/types.ts`, `src/schema.ts`, `tests/schema-migrations.test.ts`
- Test: `tests/schema-migrations.test.ts`

**Interfaces:**
- Produces `CoordinationHandoff`, `CoordinationHandoffReview`, `CoordinationLease`, `CouncilProposal`, `CouncilVote`, and `CouncilDecision` interfaces plus exact union types used by later tasks.
- Produces additive schema tables with `userId`-leading indexes; no legacy row is rewritten.

- [ ] **Step 1: Write failing migration assertions**

Add assertions that an initialized D1 harness exposes `coordination_handoffs`, `coordination_handoff_reviews`, `coordination_task_leases`, `coordination_task_events`, `council_proposals`, `council_votes`, and `council_events`, and that `ai_notes` and `agent_tasks` retain their current columns and row counts.

```ts
assert.deepEqual(await tableNames(db), [/* existing tables */, "coordination_handoffs", "council_votes"]);
assert.equal(await count(db, "ai_notes"), 1);
```

- [ ] **Step 2: Run migration test to verify it fails**

Run: `node --import tsx --test tests/schema-migrations.test.ts`

Expected: FAIL because the coordination tables do not yet exist.

- [ ] **Step 3: Add exact types and schema**

Define unions:

```ts
export const COORDINATION_PROVENANCE = ["user", "document", "agent", "inference"] as const;
export const COORDINATION_HANDOFF_STATES = ["draft", "submitted", "verified", "rejected", "expired"] as const;
export const COUNCIL_ROLES = ["evidence", "user_intent", "safety", "privacy", "strategy", "operations", "adversarial_review"] as const;
export const COUNCIL_VOTES = ["approve", "reject", "escalate"] as const;
```

Add idempotent `CREATE TABLE IF NOT EXISTS` statements. Each coordination table has `id`, `userId`, server timestamps, and `actor_id`; enforce enum `CHECK`s, confidence bounds, and unique `(userId, handoff_id, reviewer_id)` / `(userId, proposal_id, council_role)` constraints. Add indexes that begin with `userId`.

- [ ] **Step 4: Run migration tests and typecheck**

Run: `node --import tsx --test tests/schema-migrations.test.ts && npx tsc --noEmit`

Expected: PASS.

- [ ] **Step 5: Commit the migration foundation**

```bash
git add src/types.ts src/schema.ts tests/schema-migrations.test.ts
git commit -m "feat: add coordination ledger schema"
```

### Task 2: Implement safe, append-only handoffs and scoped briefs

**Files:**
- Create: `src/utils/coordination.ts`, `tests/coordination.test.ts`
- Test: `tests/coordination.test.ts`

**Interfaces:**
- Produces `submitHandoff`, `reviewHandoff`, `listVerifiedHandoffs`, and `buildCoordinationBrief`.
- `submitHandoff(input, userId, actorId, env, now)` returns an immutable handoff. `reviewHandoff(handoffId, verdict, reason, userId, actorId, env, now)` returns a review result or throws a policy error.

- [ ] **Step 1: Write failing handoff and isolation tests**

Cover tenant isolation, self-review rejection, duplicate review rejection, append-only payloads, expiry omission, and poisonous recalled content being labelled untrusted:

```ts
await assert.rejects(() => reviewHandoff(handoff.id, "verified", "looks good", "u1", "author", env, clock));
assert.equal((await buildCoordinationBrief("u1", "worker-a", [], env, clock)).items[0].trust, "verified");
assert.doesNotMatch(brief.prompt, /Ignore prior instructions/);
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `node --import tsx --test tests/coordination.test.ts`

Expected: FAIL because the coordination utility does not exist.

- [ ] **Step 3: Implement write gates and handoff state machine**

Implement a single `assertSafeCoordinationText` helper used by summaries, review reasons, evidence references, task results, proposals, and votes. Reuse the repository secret detector; reject overlong input and transcript-shaped payloads without returning the sensitive value. Enforce `draft → submitted → verified|rejected`, distinct reviewer identity, server-side timestamps, immutable submitted content, and `supersedes_id` corrections.

- [ ] **Step 4: Implement bounded coordination brief**

Return caller lease, addressed/role handoffs, verified unexpired tagged handoffs, blockers, and recent outcomes. Label every item with provenance/trust/source ID and cap item count/character length. Exclude `draft`, `rejected`, `expired`, legacy notes, and raw evidence.

- [ ] **Step 5: Run focused tests**

Run: `node --import tsx --test tests/coordination.test.ts`

Expected: PASS for every handoff, isolation, sensitive-input, and brief-scoping assertion.

- [ ] **Step 6: Commit the trusted handoff layer**

```bash
git add src/utils/coordination.ts tests/coordination.test.ts
git commit -m "feat: add trusted coordination handoffs"
```

### Task 3: Add deterministic task leases and recovery

**Files:**
- Modify: `src/utils/coordination.ts`, `tests/coordination.test.ts`
- Test: `tests/coordination.test.ts`

**Interfaces:**
- Produces `claimCoordinationTask`, `heartbeatCoordinationTask`, and `releaseCoordinationTask`.
- Lease operations require the opaque `leaseId`, current actor, and injected server time; they return only the active lease or a policy error.

- [ ] **Step 1: Add failing lease tests**

```ts
const first = await claimCoordinationTask(task.id, "u1", "worker-a", env, clock);
await assert.rejects(() => claimCoordinationTask(task.id, "u1", "worker-b", env, clock));
clock.advance(61_000);
await assert.rejects(() => heartbeatCoordinationTask(first.leaseId, "u1", "worker-a", env, clock));
```

Cover one-winner claims, matching holder/lease requirements, expiry recovery exactly once, stale lease rejection, and tenant boundary failures.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `node --import tsx --test tests/coordination.test.ts`

Expected: FAIL because lease functions do not exist.

- [ ] **Step 3: Implement atomic lease transitions**

Use D1 conditional writes keyed by `(userId, task_id)`, server-generated `lease_id`, `heartbeat_at`, and `expires_at`. Claims succeed only when no active lease exists or its expiry is before server `now`. Heartbeat, release, completion, and failure require matching actor and lease. Record every transition in `coordination_task_events`; expiry reopens task history without deleting it.

- [ ] **Step 4: Run focused tests**

Run: `node --import tsx --test tests/coordination.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit lease coordination**

```bash
git add src/utils/coordination.ts tests/coordination.test.ts
git commit -m "feat: add recoverable coordination leases"
```

### Task 4: Implement the seven-bot council and final decision artifacts

**Files:**
- Modify: `src/utils/coordination.ts`, `tests/coordination.test.ts`
- Test: `tests/coordination.test.ts`

**Interfaces:**
- Produces `createCouncilProposal`, `runCouncilDecision`, `getCouncilDecision`.
- A proposal snapshots all seven `COUNCIL_ROLES`; `runCouncilDecision` invokes every fixed role server-side, validates one immutable structured vote/reason per role, and `getCouncilDecision` computes the result from persisted votes only.

- [ ] **Step 1: Add failing council tests**

```ts
const result = await runCouncilDecision(proposal.id, "u1", env, clock, fakeCouncilRunner);
assert.equal(result.votes.length, 7);
assert.equal((await getCouncilDecision(proposal.id, "u1", env, clock)).outcome, "approved");
```

Add fixed cases: 5 approve + 2 reject = approved; 3 reject = rejected; any escalation = escalated; duplicate role vote rejects; a proposal author cannot vote; reasons/evidence IDs and dissent survive retrieval.

- [ ] **Step 2: Run focused tests to verify they fail**

Run: `node --import tsx --test tests/coordination.test.ts`

Expected: FAIL because council utilities do not exist.

- [ ] **Step 3: Implement council policy and audit storage**

Create proposals with a bounded question/options/evidence list and all seven fixed roles. Run the seven roles only through a server-owned council runner using a strict structured-output parser; reject malformed model output rather than inventing a vote. Snapshot their role list, enforce one vote per role, immutable reasons, expiry, and exact final math. Persist one final decision event only after the seventh vote; expose `pending`, `approved`, `rejected`, or `escalated`. Never dispatch an action from an outcome.

- [ ] **Step 4: Run focused tests**

Run: `node --import tsx --test tests/coordination.test.ts`

Expected: PASS for every quorum, reason, safety, and tenant-isolation assertion.

- [ ] **Step 5: Commit council decisions**

```bash
git add src/utils/coordination.ts tests/coordination.test.ts
git commit -m "feat: add seven-bot decision council"
```

### Task 5: Expose the coordination tools without changing legacy tools

**Files:**
- Create: `src/tools/coordination.ts`, `tests/coordination-tools.test.ts`
- Modify: `src/mcp.ts`, `scripts/check-tool-surface.mjs`
- Test: `tests/coordination-tools.test.ts`, `scripts/check-tool-surface.mjs`

**Interfaces:**
- Produces ten MCP tools: `coordination_handoff_submit`, `coordination_handoff_list`, `coordination_handoff_review`, `coordination_task_claim`, `coordination_task_heartbeat`, `coordination_task_release`, `coordination_brief`, `council_proposal_create`, `council_decide`, and `council_decision_get`.

- [ ] **Step 1: Write failing tool-surface tests**

Assert every new name is registered exactly once, legacy tool names remain registered, invalid enums reject through Zod, and responses expose structured success/error data.

- [ ] **Step 2: Run tool tests to verify failure**

Run: `node --import tsx --test tests/coordination-tools.test.ts && npm run test:surface`

Expected: FAIL because the tool module and surface snapshot lack the new names.

- [ ] **Step 3: Implement handler schemas and registration**

Register `registerCoordinationTools` in `src/mcp.ts`. Each mutation uses the server user scope and an explicit actor label solely for audit attribution; do not treat a user-provided label as authentication. Each handler returns `toolText`/`toolError` with concise, structured fields. Add exact new names to `EXPECTED_TOOL_NAMES` and update the expected count.

- [ ] **Step 4: Run focused tool and full surface tests**

Run: `node --import tsx --test tests/coordination-tools.test.ts && npm run test:surface`

Expected: PASS.

- [ ] **Step 5: Commit MCP exposure**

```bash
git add src/tools/coordination.ts src/mcp.ts scripts/check-tool-surface.mjs tests/coordination-tools.test.ts
git commit -m "feat: expose trusted coordination MCP tools"
```

### Task 6: Document and validate the complete workflow

**Files:**
- Modify: `static/index.html`, `tests/static-docs.test.ts`
- Test: `tests/static-docs.test.ts`, `tests/coordination.test.ts`, `tests/coordination-tools.test.ts`

**Interfaces:**
- Produces a developer-reference Multi-Agent Workflows section describing handoff → independent review → lease → brief → seven-role vote → recorded decision, with the no-external-action boundary.

- [ ] **Step 1: Write failing documentation assertions**

Assert the page includes a `multi-agent-workflows` anchor, all seven council roles, the five-approval/no-escalation rule, and the explicit no-external-action rule.

- [ ] **Step 2: Run documentation test to verify failure**

Run: `node --import tsx --test tests/static-docs.test.ts`

Expected: FAIL because the current reference lacks the workflow section.

- [ ] **Step 3: Add concise workflow documentation**

Add a navigation anchor and section showing the safe sequence and tool names. State that handoffs are data, council outcomes are recorded workflow decisions, and a client/user must authorize any external action.

- [ ] **Step 4: Run complete validation**

Run: `npm run test:all && node --import tsx --test tests/static-docs.test.ts tests/coordination.test.ts tests/coordination-tools.test.ts && git diff --check`

Expected: PASS with no whitespace errors.

- [ ] **Step 5: Commit documentation and final tests**

```bash
git add static/index.html tests/static-docs.test.ts tests/coordination.test.ts tests/coordination-tools.test.ts
git commit -m "docs: explain trusted multi-agent workflow"
```

### Task 7: Deploy and verify the authenticated Worker surface

**Files:**
- Modify: none expected
- Test: complete project test suite and live non-mutating verification

- [ ] **Step 1: Confirm committed scope**

Run: `git status --short && git log --oneline origin/codex/prompt-intelligence..HEAD`

Expected: only the coordination feature commits are ahead; unrelated `.DS_Store` files are not staged.

- [ ] **Step 2: Deploy the committed Worker**

Run: `npx wrangler deploy`

Expected: a successful `jamie-mcp-memory` Worker deployment and a new version ID.

- [ ] **Step 3: Verify public documentation and authenticated MCP discovery**

Run: `curl -fsS https://jamie-mcp-memory.jamusaaron.workers.dev/ | rg 'multi-agent-workflows|Council'`

Expected: the public reference includes the new section. With an authorized Cloudflare Access session/service token, call non-mutating MCP discovery and confirm the ten new tool names are present; do not create tenant data.

- [ ] **Step 4: Push the reviewed feature branch**

Run: `git push origin codex/prompt-intelligence`

Expected: remote branch contains every feature commit.

## Plan self-review

- **Spec coverage:** Tasks 1–4 implement storage, trusted handoffs, leases, council decisions, and all safety boundaries. Task 5 exposes the exact MCP surface without legacy changes. Task 6 documents and validates the workflow. Task 7 deploys and verifies it.
- **Placeholder scan:** No deferred implementation markers or unspecified testing steps remain.
- **Consistency:** All tasks share one `coordination` domain, identical seven-role constants, append-only semantics, `userId` scoping, and the same final-decision rule.
