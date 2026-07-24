# Trusted Second-Brain Artifacts

**Date:** 2026-07-24
**Status:** Approved design
**Target repository:** `mcp-memory-prompt-intelligence`
**Target branch:** `codex/prompt-intelligence`

## Purpose

Turn the existing living summary, self-profile, and behavioural model into a
trustworthy second-brain layer. Derived knowledge must be versioned, attributable
to exact evidence, resistant to stored prompt injection, reviewable where it
describes identity or behaviour, reversible, and safe under explicit deletion.

This is the first of three independent enhancement releases identified from the
attached `mcp-memory-skill-creator-v2` package:

1. Trusted second-brain artifacts — this specification.
2. Durable document-to-memory ingestion.
3. Automated memory lifecycle and evaluation expansion.

Each later release will receive its own design and implementation plan.

## Approved decisions

- Use one unified D1 derived-artifact ledger rather than separate summary systems
  or enhanced KV documents.
- D1 is authoritative. KV is an immutable-version cache only.
- The living summary auto-publishes only after strict evidence validation.
- Self-profile and behavioural-profile rebuilds create inactive candidates that
  require explicit approval.
- Preserve all 139 existing MCP tool names and compatible inputs.
- Add four generic artifact-management tools, bringing the intended surface to
  exactly 143 tools.
- Do not add public REST endpoints.
- Do not deploy or push as part of this design/specification phase.

## Goals

1. Give every generated factual claim one or more validated source citations.
2. Keep an auditable version history without destructive overwrites.
3. Prevent failed or malformed model output from replacing valid state.
4. Separate the user's behavioural profile from the assistant's personality.
5. Unify direct self-profile updates with the profile used by sessions and agents.
6. Invalidate derived artifacts when their underlying evidence changes.
7. Support explicit review, rejection, and safe restoration.
8. Remove derived content when its supporting source is explicitly forgotten.
9. Preserve current summaries during migration until trusted replacements exist.
10. Maintain tenant isolation and backward-compatible MCP responses.

## Non-goals

- Parsing, chunking, OCR, or extracting memories from important documents.
- A full temporal fact/supersession model for base memories.
- Replacing the existing memory, Vectorize, or session architecture.
- Automatically applying AI-extracted person-profile fields.
- Redesigning Cloudflare Access or the Worker authentication model.
- Moving the infrastructure/admin tools to a separate server.
- Automatically generating self or behavioural candidates on the cron schedule.

Authentication and operator-plane separation remain important follow-up security
work. This release will not weaken the current protection, expose new public
routes, or deploy unless the existing authenticated MCP path is verified.

## Current problems addressed

### Living summary

`rebuild_living_summary` currently overwrites one KV string from the newest 200
memories. The result has no version, timestamp, source IDs, claim citations,
watermark, freshness state, rollback, or mutation invalidation.

### Self-profile

`rebuild_self_profile` writes a static `self_profile` document consumed by sessions
and agents. Direct `update_profile` calls for the user write a separate
`person_profiles` row with `personId="self"`, which those consumers do not read.

### Behavioural model

Raw observations are durable, but the generated behavioural model is a one-hour KV
cache built from at most 100 observations. It has no provenance, invalidation,
versioning, or approval. The current assistant-personality builder is also
conceptually conflated with the user's behavioural profile.

### Model safety

Most existing summary/profile prompts interpolate stored text as instructions,
parse output permissively, and do not validate evidence. The hardened daily-recall
digest is the repository pattern to generalise: bounded sources, explicit
untrusted-data framing, mandatory citations, strict parsing, and a safe fallback.

## Architecture

### Evidence layer

The source-of-truth evidence remains:

- active memories;
- confirmed self-profile facts;
- behavioural observations;
- personality/tone feedback.

Every evidence reference used by an artifact records its source kind, source ID,
source update timestamp, and content hash. Derived artifacts are never accepted as
evidence for another artifact, which prevents circular self-reinforcement.

### Artifact ledger

D1 stores versioned artifacts of three kinds:

- `living_summary`;
- `self_profile`;
- `behavioral_profile`.

An artifact contains structured claims plus rendered text. Its lifecycle status is
one of:

- `candidate`;
- `published`;
- `stale`;
- `superseded`;
- `rejected`;
- `tombstoned`.

`published` and `stale` are the two active states. A stale artifact remains readable
until a valid replacement is published, except when privacy deletion requires it
to be tombstoned.

The normal lifecycle is:

`candidate -> published -> stale -> superseded`

Review rejection moves a candidate to `rejected`. Explicit source deletion can move
any affected artifact directly to `tombstoned`.

### Synthesis boundary

The synthesis engine is isolated from D1 persistence and MCP registration. It:

1. Selects deterministic, bounded evidence.
2. Frames all evidence as untrusted data.
3. Requests structured claims with citations.
4. Strictly validates the complete response.
5. Produces canonical JSON, rendered text, hashes, and validation metadata.

The artifact store owns migrations, versions, state transitions, source links,
invalidation, publication, review, restoration, deletion cascades, and cache
updates.

### Read path

Consumers resolve the active artifact from D1 first. The immutable artifact ID is
then used to read a KV cache entry:

`artifact:{userId}:{kind}:{artifactId}`

If the cache is absent, content is read from D1 and repopulated. KV never stores the
authoritative current pointer, so stale cache state cannot make an old artifact
current.

Session briefs and agent context read only the active artifact. Candidates,
rejected versions, and superseded history never enter ordinary context.

## Data model

### `schema_migrations`

Tracks ordered migrations introduced by this release.

- `version INTEGER PRIMARY KEY`
- `name TEXT NOT NULL`
- `checksum TEXT NOT NULL`
- `applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP`

Existing idempotent table creation remains temporarily for legacy tables. The new
migration runner records a verified baseline and applies all new artifact/profile
migrations exactly once. Migration errors are surfaced; they are not treated as
"column already exists" unless schema inspection confirms that condition.

### `derived_artifacts`

- `id TEXT PRIMARY KEY`
- `userId TEXT NOT NULL`
- `kind TEXT NOT NULL`
- `version INTEGER NOT NULL`
- `status TEXT NOT NULL`
- `validation_state TEXT NOT NULL`
- `content_json TEXT`
- `rendered_text TEXT`
- `source_watermark TEXT`
- `eligible_source_count INTEGER NOT NULL DEFAULT 0`
- `selected_source_count INTEGER NOT NULL DEFAULT 0`
- `source_truncated INTEGER NOT NULL DEFAULT 0`
- `content_sha256 TEXT`
- `model TEXT`
- `prompt_version TEXT NOT NULL`
- `validation_json TEXT NOT NULL DEFAULT '{}'`
- `supersedes_id TEXT`
- `retry_count INTEGER NOT NULL DEFAULT 0`
- `next_retry_at TEXT`
- `created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP`
- `published_at TEXT`
- `reviewed_at TEXT`
- `reviewed_by TEXT`

Constraints and indexes:

- unique `(userId, kind, version)`;
- partial unique `(userId, kind)` for active statuses `published` and `stale`;
- index `(userId, kind, status, created_at)`;
- index `(userId, status, next_retry_at)`.

`validation_state` is `validated` or `legacy_unverified`. Tombstoning sets
`content_json`, `rendered_text`, and cache content to null while retaining the
non-content identifiers, hashes, and audit history.

### `derived_artifact_sources`

- `artifact_id TEXT NOT NULL`
- `userId TEXT NOT NULL`
- `claim_id TEXT NOT NULL`
- `source_kind TEXT NOT NULL`
- `source_id TEXT NOT NULL`
- `source_updated_at TEXT NOT NULL`
- `source_sha256 TEXT NOT NULL`
- `citation_role TEXT NOT NULL DEFAULT 'supporting'`

The composite primary key is:

`(artifact_id, claim_id, source_kind, source_id)`

An index on `(userId, source_kind, source_id)` supports invalidation and deletion
cascades without scanning artifact content.

### `derived_artifact_events`

Append-only operational and review audit:

- `id TEXT PRIMARY KEY`
- `userId TEXT NOT NULL`
- `artifact_id TEXT`
- `kind TEXT NOT NULL`
- `event_type TEXT NOT NULL`
- `reason_code TEXT`
- `actor TEXT NOT NULL`
- `source_watermark TEXT`
- `metadata_json TEXT NOT NULL DEFAULT '{}'`
- `created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP`

Events contain no raw memory text, generated claims, secrets, or prompt bodies.
Generation failures can be recorded without creating an invalid artifact row.

### `profile_facts`

Canonical explicitly confirmed facts about the user:

- `id TEXT PRIMARY KEY`
- `userId TEXT NOT NULL`
- `section TEXT NOT NULL`
- `field TEXT NOT NULL`
- `value TEXT`
- `confidence REAL NOT NULL`
- `source_type TEXT NOT NULL`
- `source_id TEXT`
- `status TEXT NOT NULL`
- `supersedes_id TEXT`
- `verified_at TEXT NOT NULL`
- `created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP`
- `updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP`

There is one active fact per `(userId, section, field)`. Updates create a new fact
and supersede the previous one instead of replacing section JSON. Deletion
tombstones the value while retaining non-content audit metadata.

### Behavioural-source additions

Additive migrations extend behavioural observations with:

- `source_type TEXT NOT NULL DEFAULT 'observed'`;
- `confidence REAL NOT NULL DEFAULT 0.5`;
- `status TEXT NOT NULL DEFAULT 'active'`;
- `verified_at TEXT`.

Tone/personality feedback remains separate evidence. `build_personality` continues
to build the assistant-facing personality and is not stored as a user behavioural
artifact.

## Claim contract

The model returns the claim fields below except `id`. After validation, the server
derives a stable claim ID from the artifact kind plus canonical section, text, and
citations. Model output can therefore neither choose database identifiers nor
collide deliberately with another claim.

Every persisted claim has:

```json
{
  "id": "stable-claim-id",
  "section": "identity",
  "text": "One factual, self-contained claim.",
  "confidence": 0.9,
  "provenance": "stated",
  "sensitivity": "normal",
  "citations": [
    {
      "source_kind": "memory",
      "source_id": "memory-id"
    }
  ]
}
```

Validation requires:

1. A unique server-derived claim ID.
2. A supported section for the artifact kind.
3. Non-empty, bounded, plain-text claims.
4. Confidence between 0 and 1.
5. At least one citation for every factual claim.
6. Every citation exactly matches the supplied evidence pack.
7. No citation to suppressed, deleted, or tombstoned evidence.
8. No embedded tool call, protocol change, or instruction-following content.
9. Sensitive claims satisfy the rules below.
10. Canonical JSON can be rendered deterministically.

Unknown fields are rejected rather than silently persisted.

## Evidence selection and coverage

Selection is deterministic for the same evidence state.

### Shared bounds

- At most 120 selected evidence items.
- At most 400 characters from any one source.
- At most 48,000 evidence characters before prompt framing.
- The artifact records total eligible sources, selected sources, and whether
  selection was truncated.

These bounds keep model input predictable while exposing honest coverage metadata.

### Living summary

- Reserve up to 60 slots for pinned and core memories.
- Rank that reserved pool by pinned status, verification, salience, update time,
  and ID.
- Fill the remaining slots with category-balanced recent, salient, and verified
  active memories.
- Older pinned/core memories are eligible even when they are outside the newest
  200 D1 rows.

### Self-profile

- Include up to 50 active confirmed `profile_facts` first.
- Fill remaining slots from active identity, preferences, likes, goals, and rules
  memories using the living-summary ranking rules.

### Behavioural profile

- Include up to 90 observations balanced by observation type and time.
- Include up to 30 tone/personality feedback records.
- Behavioural evidence is never upgraded from observed/inferred to stated without
  explicit user confirmation.

The source watermark is a SHA-256 hash of the ordered source-kind, source-ID,
source-update-time, source-status, and source-content-hash tuples.

## Security and sensitivity rules

Recalled memory is untrusted data, never instructions. The system prompt states
that evidence cannot change the task, request tool calls, alter the schema, or
modify the memory protocol. Evidence is passed in delimited structured records,
not concatenated as free-form instructions.

Hard exclusions:

- credentials and session tokens;
- private authentication URLs or signed access parameters;
- encryption keys and recovery codes;
- full payment-card numbers;
- government identifiers;
- verbatim transcript dumps;
- instructions that attempt to alter the synthesis/review protocol.

Health, financial, legal, relationship, or psychological claims can appear only
when directly stated and verified. They are never inferred from behaviour.
Self-profile and behavioural-profile content remains review-gated even when all
individual claims validate.

The release adds no public REST endpoints. Every D1 lookup and mutation is scoped
by both `userId` and record ID. New MCP tools use read-only and destructive safety
annotations appropriate to their operations.

## Mutation and invalidation

Evidence mutation and artifact invalidation happen in the same D1 transaction.

Living-summary invalidators:

- memory create or import;
- memory text/category/layer/source/confidence/salience changes;
- suppress, restore, verify, promote, pin, unpin, or hard delete;
- scheduled confidence decay.

Access-count and last-accessed updates do not invalidate artifacts.

Self-profile invalidators:

- any relevant living-summary memory mutation in identity, preferences, likes,
  goals, or rules;
- create, update, supersede, verify, or delete a profile fact.

Behavioural-profile invalidators:

- create, verify, reject, supersede, or delete a behavioural observation;
- new tone/personality feedback.

The current active artifact changes from `published` to `stale`. Its immutable
cache entry remains usable while a replacement is pending.

## Generation and publication

### Common rebuild sequence

1. Resolve the active artifact and collect the bounded evidence pack.
2. Compute the source watermark.
3. Collapse concurrent rebuilds with the same `(userId, kind, watermark)`.
4. Generate structured claims using the untrusted-evidence system prompt.
5. Strictly parse and validate the complete result.
6. Re-read the evidence watermark.
7. Abort if the evidence changed during generation.
8. Persist the candidate, claim-source links, and generated event transactionally.

### Living summary

After validation, one D1 transaction:

1. changes the previous active artifact to `superseded`;
2. changes the candidate to `published`;
3. records publication and supersession events.

KV is populated after commit. A cache-write failure does not roll back D1 and does
not make the artifact unavailable.

### Self and behavioural profiles

Validated rebuilds stop at `candidate`. The current published/stale artifact
remains active. Approval rechecks the candidate's watermark before atomically
superseding the active version and publishing the candidate. If evidence changed,
approval refuses and requests a fresh rebuild.

Rejection preserves the candidate with status `rejected` and records a reason.

### Restoration

Restoration:

1. rejects tombstoned content;
2. confirms every cited source still exists and has the recorded hash;
3. clones the historical content into a new version;
4. atomically supersedes the current active version;
5. publishes the new version with a `restored` event.

It never rewrites the historical row or restores claims whose evidence was deleted
or changed.

## MCP tool changes

### Existing tools

`rebuild_living_summary`

- Generates and validates a candidate.
- Auto-publishes only on success.
- Returns artifact ID, version, source coverage, validation result, and rendered
  summary.

`get_living_summary`

- Reads the active D1 artifact and immutable KV cache.
- Returns rendered text plus artifact ID, version, freshness, validation state,
  source coverage, and timestamps.

`rebuild_self_profile`

- Creates an inactive candidate.
- Returns candidate ID, claims, citations, validation, and review instructions.

`behavioral_model`

- Without rebuild, returns the active published/stale behavioural profile.
- With rebuild, creates an inactive candidate and returns its review ID.

`update_profile`

- With a person ID, preserves existing person-profile behaviour.
- Without a person ID, creates/supersedes a canonical confirmed `profile_fact`
  rather than writing a disconnected `"self"` person row.
- Direct self facts are stored as `source_type="stated"`, confidence `1.0`, and
  verified at the write timestamp because this tool represents an explicit
  profile update rather than an AI extraction.

`record_observation`

- Writes provenance, confidence, and verification metadata.
- Adds optional `source_type`, `confidence`, and `verified` inputs while preserving
  the current call shape and defaults to `observed`, `0.5`, and `false`.
- Marks only the behavioural profile stale.

`get_session_brief`

- Includes only active artifacts.
- Labels stale and legacy-unverified content.
- Never includes candidates or rejected versions.

### New tools

`list_derived_artifacts`

- Filters by kind and status.
- Uses bounded cursor pagination with a default of 20 and maximum of 50.
- Returns metadata and short previews, not full source text.
- Read-only.

`get_derived_artifact`

- Retrieves one artifact by ID within the current tenant.
- Returns claims, citations, validation, coverage, lifecycle metadata, and events.
- Refuses tombstoned content while returning its non-content audit status.
- Read-only.

`review_derived_artifact`

- Accepts artifact ID, `approve` or `reject`, and an optional reason.
- Approval is allowed only for current, validated self/behavioural candidates with
  an unchanged watermark.
- Rejection requires a reason.
- Mutating and review-sensitive.

`restore_derived_artifact`

- Accepts a historical artifact ID and a required reason.
- Applies the restoration rules above and returns the new published version.
- Mutating and review-sensitive.

All four tools return readable MCP text plus schema-matching `structuredContent`.
The exact tool-name snapshot is updated from 139 to 143; existing names cannot be
renamed or removed to compensate for the additions.

## Scheduled maintenance

The existing 30-minute cron remains the scheduler.

- Select at most five stale or missing living summaries per invocation.
- Process at most one rebuild per tenant per invocation.
- Never auto-generate self or behavioural candidates.
- On failure, increment retry count and set exponential backoff starting at 30
  minutes and capped at 24 hours.
- A successful publish resets retry state.
- One tenant's failure does not stop processing the remaining bounded set.

Maintenance logs tenant-safe IDs and reason codes, not evidence or generated text.

## Legacy migration

Migration is lazy per tenant and artifact kind:

1. If D1 has an active artifact, use it.
2. Otherwise read the existing living-summary KV key or self-profile/static
   document; read the behavioural cache only if it still exists.
3. Import existing content as a new active `stale` artifact with
   `validation_state="legacy_unverified"`, zero source links, and a legacy-import
   event.
4. Keep it available until a trusted replacement is published.

No existing profile disappears during migration.

Because legacy content has no source map, any relevant explicit source deletion
conservatively tombstones the corresponding legacy artifact.

## Failure handling

The following conditions fail closed:

- model exception or timeout;
- empty generated text;
- malformed or extra JSON fields;
- unknown, missing, suppressed, or deleted citations;
- unsupported or instruction-like claims;
- invalid confidence or sensitivity values;
- output above configured limits;
- source watermark change;
- D1 transaction failure.

No invalid artifact is published. The previous active artifact remains available,
and a non-sensitive `generation_failed` event records the reason code. Failed
attempts never persist raw prompts, evidence, or partial model output.

KV failures degrade performance only. D1 failures cannot leave a partial
publication because all state transitions and source-link writes use transactional
D1 batches.

## Explicit deletion and derived-data cascade

Hard deletion is the privacy exception to immutable content history.

When a source is explicitly forgotten:

1. Find every artifact version through `derived_artifact_sources`.
2. Tombstone each affected artifact's content and delete its immutable KV cache.
3. Retain only artifact ID, kind, version, hashes, timestamps, and tombstone events.
4. Delete the affected `derived_artifact_sources` rows; the tombstone event retains
   only the source kind and a one-way hash of the deleted source ID.
5. If an active living summary was affected, leave no readable active version and
   queue an automatic rebuild from remaining evidence.
6. If an active self or behavioural profile was affected, leave no readable active
   version and require its existing rebuild tool to create a fresh review
   candidate; cron never generates profile candidates.
7. Session briefs omit the affected artifact until a replacement publishes.

If an artifact claim has several sources, the initial release still tombstones the
whole artifact version. This conservative rule is simpler to verify and guarantees
that forgotten content cannot survive in a generated paragraph.

## Testing strategy

### Unit tests

- claim-schema acceptance and rejection;
- exact citation validation;
- sensitivity and hard-exclusion rules;
- deterministic selection, truncation, and watermarks;
- canonical rendering and hashes;
- artifact state-machine transitions;
- profile-fact supersession and merge safety;
- backoff calculation;
- tombstone/redaction behaviour.

### Store and migration tests

- ordered idempotent migrations;
- one active artifact per tenant and kind;
- atomic publish/review/restore;
- concurrent same-watermark rebuild collapse;
- D1-authoritative reads with missing or stale KV;
- legacy living, self, and behavioural imports;
- source-index invalidation;
- tenant-scoped lookups and mutations.

### Tool and integration tests

- write -> rebuild -> new-session recall;
- mutation invalidates only affected kinds;
- self/behavioural candidates never enter session context before approval;
- approved candidates appear in later session briefs;
- rejection leaves current content unchanged;
- restoration creates a new version;
- empty, malformed, uncited, poisoned, or sensitive-inference output leaves the
  previous valid artifact active;
- old pinned/core memories outside the newest 200 remain eligible;
- explicit forget tombstones all affected derived content;
- two tenants cannot list, read, review, restore, invalidate, or delete each
  other's artifacts;
- scheduled maintenance limits, isolation, and retry backoff;
- exact 143-tool name snapshot;
- readable `content`, structured output schemas, annotations, and existing input
  compatibility.

### Repository gates

- complete Node test suite;
- TypeScript compiler with no emit;
- exact tool-surface guard;
- scoped Biome formatting and lint checks;
- Wrangler deployment dry-run from the intended source snapshot.

If deployment is separately approved, live verification must cover:

1. authenticated SSE handshake;
2. advertised companion message route or real tool call;
3. exact tool discovery;
4. living-summary rebuild and session consumption;
5. self/behavioural candidate review;
6. restoration;
7. deletion cascade.

An open SSE stream alone is not considered healthy.

## Completion criteria

The release is complete only when:

1. Exactly one active artifact exists per tenant and kind when content is
   available.
2. Every published factual claim in a validated artifact cites known evidence.
3. Living-summary validation is mandatory before automatic publication.
4. Self and behavioural candidates require explicit approval.
5. Failed generation cannot replace or corrupt valid state.
6. Session briefs never consume candidate or rejected artifacts.
7. Restoration creates a new version and cannot revive deleted/changed evidence.
8. Explicit source deletion makes all affected derived content inaccessible.
9. Legacy content remains available until trusted replacement or privacy deletion.
10. KV loss does not lose history or current-state truth.
11. Cross-tenant artifact access is rejected.
12. All existing tool contracts remain compatible and the exact 143-tool surface
    passes.
13. Existing unrelated working-tree changes remain untouched.
14. Local tests, compiler, surface guard, formatting/lint, and Wrangler dry-run
    pass.
15. No push, deployment, or Access-policy change occurs without separate explicit
    approval.

## Implementation boundaries

New focused modules should own the feature:

- `src/utils/artifact-store.ts`
- `src/utils/artifact-synthesis.ts`
- `src/utils/profile-facts.ts`
- `src/tools/derived-artifacts.ts`

Existing tool files should delegate to those modules rather than absorb the state
machine or validation logic. The implementation should avoid modifying the
currently dirty Workers AI response adapter unless integration proves a minimal
change is necessary; synthesis can call the existing exported model helpers.

The detailed implementation sequence, test-first steps, and commit boundaries will
be defined only after this specification is reviewed and approved.
