# MCP Memory

Persistent, structured long-term memory system for LLM assistants, built as a Cloudflare Worker exposing an MCP server with 106 tools.

## Stack

- **Runtime**: Cloudflare Workers
- **Framework**: Hono (HTTP routing) + Agents SDK (MCP protocol)
- **Database**: Cloudflare D1 (structured records, profiles, sessions, transcripts)
- **Cache**: Cloudflare KV, optional — falls back to D1 `kv_store` table when unbound (living summary, personality profile, session state)
- **Files**: Cloudflare R2, optional — falls back to D1 `static_files` table when unbound (context docs, protocol files, personality configs)
- **Vector Search**: Cloudflare Vectorize with `@cf/baai/bge-m3` embeddings (1024 dimensions, cosine similarity)
- **AI**: Workers AI for embeddings, triage, extraction, summarization
- **State**: Durable Objects (`MyMCP` class)

## Project Structure

- `src/index.ts` — Hono app with REST endpoints and MCP mount
- `src/mcp.ts` — MCP server aggregating all tool groups
- `src/schema.ts` — D1 database migrations (12 tables)
- `src/types.ts` — Type definitions for all data models
- `src/tools/memory.ts` — Memory CRUD, search, maintenance & analysis (29 tools)
- `src/tools/people.ts` — People/profile management (16 tools)
- `src/tools/uncertainty.ts` — Uncertainty/clarification loop (4 tools)
- `src/tools/session.ts` — Session lifecycle (10 tools)
- `src/tools/static-files.ts` — R2-backed static files (4 tools)
- `src/tools/behavioral.ts` — Behavioral & personality modeling (7 tools)
- `src/tools/ingestion.ts` — Ingestion pipeline (3 tools)
- `src/tools/ai-agents.ts` — Cross-agent shared memory (6 tools)
- `src/tools/health.ts` — System health check (1 tool)
- `src/tools/infra.ts` — Cloudflare infra passthrough (26 tools)
- `src/utils/db.ts` — D1 database operations
- `src/utils/vectorize.ts` — Vectorize embedding and search
- `src/utils/kv.ts` — KV cache operations
- `src/utils/r2.ts` — R2 file operations
- `src/utils/ai.ts` — Workers AI helpers (triage, extraction, summarization)
- `src/utils/cascade.ts` — Write cascade: keeps the living summary and self-profile in sync with the memory store
- `static/index.html` — Web UI for managing memories
- `wrangler.jsonc` — Cloudflare Workers configuration

## Commands

- `npm run dev` — Start local dev server (requires Cloudflare credentials)
- `npm run deploy` — Deploy to Cloudflare Workers
- `npx tsc --noEmit` — Type-check

## Architecture

Each user gets an isolated namespace. Memories are structured with category, layer, confidence, salience, and emotion weight. The system supports contradiction detection, confidence decay, write cascades, and semantic search. The MCP server runs as a Durable Object mounted at `/{userId}/sse`.

## MCP Server Configuration

To use with Claude Code, configure in `.claude/settings.json`:
```json
{
  "mcpServers": {
    "mcp-memory": {
      "command": "npx",
      "args": ["mcp-remote", "http://localhost:8787/{your-user-id}/sse"]
    }
  }
}
```

Replace `http://localhost:8787` with your deployed Cloudflare Workers URL for production.

## Authentication

Auth is optional and off by default. To require an API key on all data routes, set the `MEMORY_API_KEY` secret (`wrangler secret put MEMORY_API_KEY`). Clients then pass `Authorization: Bearer <key>` or append `?key=<key>` to the URL (e.g. the SSE endpoint: `/{userId}/sse?key=<key>`). MCP message POSTs within an authenticated SSE session are validated by their unguessable session ID.

## Resilience

Semantic search, AI triage, and contradiction detection require Workers AI + Vectorize (remote resources). When those are unreachable (e.g. local dev without Cloudflare auth), search tools fall back to D1 keyword search, triage stores with default categorization, and writes skip the contradiction check — core functionality keeps working.

## Write Cascade

Memory writes automatically keep three derived documents current, without an AI call on every write:

- **Living summary** (KV, `get_living_summary`/`rebuild_living_summary`) — an AI-generated overview built from all active memories
- **Self-profile** (R2/D1 static file `self_profile`, `rebuild_self_profile`) — built from memories in the `identity`, `preferences`, `likes`, `goals`, and `rules` categories
- **Behavioral model** (KV, `behavioral_model`) — built from behavioral observations and personality feedback

`write_memory`, `batch_write_memories`, `edit_memory` (on text changes), `suppress_memory`, `restore_memory`, and `forget_memory` bump the living-summary/self-profile dirty counters; `record_observation` and `personality_feedback` bump the behavioral-model counter (`src/utils/cascade.ts`, no AI call). Two triggers consume them:

- **Threshold-based**: on every write, if a counter has crossed its threshold (10 living summary, 5 self-profile, 5 behavioral model) the corresponding document is rebuilt automatically — so a burst of writes pays the AI cost once instead of on every call.
- **Session-boundary**: `session_close` rebuilds any document whose counter is non-zero, since a session boundary is infrequent enough that the AI cost is worth paying regardless of how small the change was.

`get_session_brief` surfaces staleness directly (e.g. "N memory changes since this was last built") so the caller knows whether to trust the cached summary or trigger a manual rebuild. All rebuild attempts are best-effort — a failure (e.g. Workers AI unreachable) is logged and leaves the dirty counter untouched rather than failing the write/close that triggered it.

## Cross-Tool Integration

Beyond the write cascade, several tools feed each other so knowledge isn't stranded:

- **Answered questions become memories.** `record_user_answer` closes an uncertainty *and* (by default) writes the resolved question/answer as a memory, running the write cascade — so a clarification you asked for via `ask_user` is retained, not lost when the question closes. Pass `store_as_memory=false` to opt out.
- **`get_session_brief` is the operational hub.** Alongside the living summary and current context, it pulls in open uncertainties (from `ask_user`) and memories needing reverification (decayed confidence), so a session starts knowing what to ask and what to confirm without separately calling `list_open_uncertainties` or `list_reverify_queue`.

## Scheduled Maintenance

`wrangler.jsonc` defines a cron trigger (`triggers.crons`) that fires `scheduled()` in `src/index.ts`. It runs a decay sweep (`runDecaySweep` in `src/utils/db.ts`) across every user with stored memories — enumerated via `listDistinctUserIds` — same logic as the `run_decay_sweep` MCP tool, just applied account-wide instead of to one caller's `userId`. Test locally with `wrangler dev --test-scheduled` and `curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"`.
