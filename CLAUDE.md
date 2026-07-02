# MCP Memory

Persistent, structured long-term memory system for LLM assistants, built as a Cloudflare Worker exposing an MCP server with 97 tools and no R2 subscription dependency.

## Stack

- **Runtime**: Cloudflare Workers
- **Framework**: Hono (HTTP routing) + Agents SDK (MCP protocol)
- **Database**: Cloudflare D1 (structured records, profiles, sessions, transcripts)
- **Cache and persistent context**: Cloudflare KV (living summary, personality profile, session state, context documents)
- **Vector Search**: Cloudflare Vectorize with `@cf/baai/bge-m3` embeddings (1024 dimensions, cosine similarity)
- **AI**: Workers AI for embeddings, triage, extraction, summarization
- **State**: Durable Objects (`MyMCP` class)

## Project Structure

- `src/index.ts` — Hono app with REST endpoints and MCP mount
- `src/mcp.ts` — MCP server aggregating all tool groups
- `src/schema.ts` — D1 database migrations (10 tables)
- `src/types.ts` — Type definitions for all data models
- `src/tools/memory.ts` — Memory CRUD, search, maintenance, and analysis
- `src/tools/people.ts` — People/profile management
- `src/tools/uncertainty.ts` — Uncertainty/clarification loop
- `src/tools/session.ts` — Session lifecycle
- `src/tools/behavioral.ts` — Behavioral and personality modeling
- `src/tools/ingestion.ts` — Ingestion pipeline (3 tools)
- `src/tools/ai-agents.ts` — Cross-agent shared memory
- `src/tools/health.ts` — System health and degraded-capability reporting
- `src/tools/infra.ts` — Cloudflare infra passthrough (22 tools; optional credentials required)
- `src/utils/db.ts` — D1 database operations
- `src/utils/vectorize.ts` — Vectorize embedding and search
- `src/utils/kv.ts` — KV cache operations
- `src/utils/static-context.ts` — KV-backed persistent context operations
- `src/utils/cloudflare-api.ts` — validated optional Cloudflare account API access
- `src/utils/tool-result.ts` — consistent MCP text and error results
- `src/utils/ai.ts` — Workers AI helpers (triage, extraction, summarization)
- `static/index.html` — Web UI for managing memories
- `wrangler.jsonc` — Cloudflare Workers configuration

## Commands

- `npm run dev` — Start local dev server (requires Cloudflare credentials)
- `npm run deploy` — Deploy to Cloudflare Workers
- `npx tsc --noEmit` — Type-check
- `npm run test:all` — Run regression, surface-contract, and type checks

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
