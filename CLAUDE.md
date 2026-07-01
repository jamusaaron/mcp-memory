# MCP Memory

Cloudflare Workers MCP server that provides persistent memory across conversations for MCP clients.

## Stack

- **Runtime**: Cloudflare Workers
- **Framework**: Hono (HTTP routing) + Agents SDK (MCP protocol)
- **Database**: Cloudflare D1 (SQL storage)
- **Vector Search**: Cloudflare Vectorize with `@cf/baai/bge-m3` embeddings (1024 dimensions, cosine similarity)
- **State**: Durable Objects (`MyMCP` class)

## Project Structure

- `src/index.ts` — Hono app with REST endpoints and MCP mount
- `src/mcp.ts` — MCP server with tools: `addToMCPMemory`, `searchMCPMemory`, `listMCPMemories`, `deleteMCPMemory`, `updateMCPMemory`
- `src/utils/db.ts` — D1 database operations
- `src/utils/vectorize.ts` — Vectorize embedding and search operations
- `static/index.html` — Web UI for managing memories
- `wrangler.jsonc` — Cloudflare Workers configuration

## Commands

- `npm run dev` — Start local dev server (requires Cloudflare credentials)
- `npm run deploy` — Deploy to Cloudflare Workers
- `npx tsc --noEmit` — Type-check

## Architecture

Each user gets an isolated namespace in Vectorize. Memories are dual-stored: text in D1, vector embeddings in Vectorize. The MCP server runs as a Durable Object mounted at `/{userId}/sse`.

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
