# MCP Memory

Persistent, structured long-term memory system for LLM assistants, built as a Cloudflare Worker exposing an MCP server with 105 tools.

## Stack

- **Runtime**: Cloudflare Workers
- **Framework**: Hono (HTTP routing) + Agents SDK (MCP protocol)
- **Database**: Cloudflare D1 (structured records, profiles, sessions, transcripts)
- **Cache**: Cloudflare KV (living summary, personality profile, session state)
- **Files**: Cloudflare R2 (context docs, protocol files, personality configs)
- **Vector Search**: Cloudflare Vectorize with `@cf/baai/bge-m3` embeddings (1024 dimensions, cosine similarity)
- **AI**: Workers AI for embeddings, triage, extraction, summarization
- **State**: Durable Objects (`MyMCP` class)

## Project Structure

- `src/index.ts` — Hono app with REST endpoints and MCP mount
- `src/mcp.ts` — MCP server aggregating all tool groups
- `src/schema.ts` — D1 database migrations (10 tables)
- `src/types.ts` — Type definitions for all data models
- `src/tools/memory.ts` — Memory CRUD, search, maintenance & analysis (28 tools)
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
