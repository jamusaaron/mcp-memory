# Trusted Multi-Agent Coordination and Decision Council — Design

## Purpose

Enhance MCP Memory's existing notes, presence, task-board, role-agent, and debate capabilities with a trusted coordination layer. The feature makes multi-agent work auditable, tenant-isolated, recoverable, and safe to use as context across sessions.

It also adds a seven-bot Decision Council. The council reaches a final decision for an MCP workflow proposal and persists every vote, rationale, evidence reference, and dissent. A council decision is a recorded workflow decision only: it cannot autonomously invoke external services, alter infrastructure, send communications, or perform any irreversible action.

## Scope

The enhancement is additive. Existing `ai_note_*`, agent-presence, task-board, handoff, role-agent, and debate tools remain compatible. New tools provide the trusted workflow; existing clients may migrate incrementally.

## Coordination model

### Immutable handoffs

A handoff records one concise, shareable unit of work. It contains a tenant-scoped ID, sender, optional recipient/role, summary, evidence references, provenance, confidence, expiry, trust state, timestamps, and a review history. Handoff payloads are immutable after submission. A correction is a new handoff that supersedes the previous record, leaving the original audit trail intact.

Allowed provenance is `user`, `document`, `agent`, or `inference`. User and document evidence retain their source labels; agent inference is never silently promoted to user fact.

### Leased task ownership

Task claims gain a bounded lease. A claimant has an expiry timestamp and must renew it through a heartbeat. A claim is released when the work completes, fails, is explicitly released, or the lease expires. Expiry reopens the task without deleting earlier claims or results. Claim, release, completion, and failure history stays visible to later agents.

### Trust states

Handoffs progress through `draft`, `submitted`, `verified`, `rejected`, or `expired`.

- A submitter may create or submit a handoff.
- A different agent may verify or reject it and must provide a reason.
- A handoff may not verify itself; an agent may not review its own work.
- Only verified, unexpired handoffs enter the default coordination brief.

### Scoped coordination brief

`coordination_brief` returns only context useful to a caller: that agent's valid leases, handoffs explicitly addressed to it or its role, verified unexpired handoffs relevant to supplied tags, open blockers, and recent task outcomes. It does not return a tenant-wide note dump and applies a bounded result limit.

## Seven-bot Decision Council

The council has exactly these seven deterministic roles:

1. **Evidence** — assesses factual support and evidence gaps.
2. **User intent** — checks whether the proposal matches the stated goal and constraints.
3. **Safety** — identifies memory poisoning, prompt-injection, and harmful-action risks.
4. **Privacy** — checks provenance, data minimisation, tenant isolation, and exclusion rules.
5. **Strategy** — compares options, consequences, and reversibility.
6. **Operations** — checks feasibility, dependencies, rollout, and rollback implications.
7. **Adversarial review** — searches for contradictions, failure cases, and unaddressed dissent.

Each council member records an `approve`, `reject`, or `escalate` vote and a required reason. Members may cite handoff IDs and evidence IDs, but retrieved text is treated as untrusted data, never executable instruction.

A decision is final only when all seven votes are recorded. Approval requires at least five `approve` votes and no `escalate` vote. Rejection occurs when three or more members reject. Any `escalate` result requires a human or explicit caller resolution; it is not an approval. The final artifact contains the immutable proposal, every vote and rationale, the outcome, timestamps, and a compact synthesis. The caller may request a new council run; it supersedes, but never overwrites, the earlier decision.

## Safety and memory policy

- Every record is scoped by `userId`; no caller can supply or derive another tenant's scope.
- Retrieved handoffs, notes, council reasons, and evidence are untrusted data. They cannot change protocol rules or cause tool execution.
- Writes require concise, atomic summaries. Credentials, tokens, session identifiers, government/payment IDs, raw transcript payloads, and unrequested sensitive third-party data are rejected.
- Sensitive personal data is excluded unless a future explicit feature policy and user request allow it; this feature ships with the restrictive default.
- Inferences retain their provenance and confidence; verification requires a distinct reviewer and does not rewrite the original source.
- Council decisions never carry action authority beyond returning a recorded outcome to the MCP client.

## Public tool surface

New tools are grouped as follows:

- `coordination_handoff_submit`, `coordination_handoff_list`, `coordination_handoff_review`
- `coordination_task_claim`, `coordination_task_heartbeat`, `coordination_task_release`
- `coordination_brief`
- `council_proposal_create`, `council_vote_record`, `council_decision_get`

Exact schemas, result fields, and descriptions are derived from the implementation and included in the new tests. Existing tools are neither renamed nor removed.

## Storage and migration

Additive D1 tables store handoffs, handoff reviews, task-claim history, council proposals, and council votes. Required indexes include `userId` plus the principal filter dimensions: trust/expiry for handoffs, task/lease for claims, and proposal/council role for votes. The migration is idempotent and never modifies existing `ai_notes` or `agent_tasks` rows.

## Testing and evaluation

The test suite must deterministically verify:

- tenant isolation for every new query and mutation;
- immutable submitted handoffs and supersession audit trails;
- a submitter cannot verify their own handoff;
- expired handoffs and leases do not appear as active context;
- heartbeats only extend the current claimant's active lease;
- the coordination brief excludes unverified, expired, unrelated, and excessive data;
- sensitive-content write rejection;
- all seven council roles must vote before a final decision;
- five approvals with no escalation approves; three rejections rejects; any escalation escalates;
- every council decision preserves reasons, evidence references, dissent, and source provenance;
- retrieved malicious text cannot alter a handoff's trust state or council outcome.

The developer reference receives a Multi-Agent Workflows section documenting the coordination sequence, decision semantics, safety boundary, and example tool order.

## Rollout

Run TypeScript, the full existing suite, new coordination tests, and the tool-surface snapshot before deployment. Deploy only after the committed changes are pushed. Verify the public root and a non-mutating MCP tool-discovery path through the authenticated route where credentials are available. No production tenant data is created during verification.

## Out of scope

- Automatic external execution based on a council result.
- Changing the existing tool names or behavior.
- A generic autonomous agent runtime, agent billing, or cross-tenant collaboration.
