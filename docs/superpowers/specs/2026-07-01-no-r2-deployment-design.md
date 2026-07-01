# No-R2 MCP Memory Deployment Design

**Status:** Approved  
**Date:** 2026-07-01

## Goal

Deploy the merged PR #2 MCP Memory server without requiring a Cloudflare R2 subscription. The deployed server must advertise 97 functional tools rather than advertising R2-dependent tools that cannot work.

## Tool-surface change

Remove these eight tools from registration:

- `read_static_file`
- `update_static_file`
- `delete_static_file`
- `list_static_files`
- `r2_bucket_create`
- `r2_bucket_get`
- `r2_bucket_delete`
- `r2_buckets_list`

All other PR #2 tools remain registered. The expected live inventory is 97 tools.

## Configuration change

Remove the `r2_buckets` binding from `wrangler.jsonc`. Keep D1, KV, Vectorize, Workers AI, Durable Objects, assets, and rate limiting unchanged.

The unused static-file and R2 helper source can remain in the repository for future restoration, but it must be unreachable from the MCP registry and must not require a runtime binding.

## Verification

Add a repository-level tool-surface contract check that:

1. extracts statically registered MCP tool names;
2. fails if any of the eight removed names are registered;
3. fails unless exactly 97 tools are registered;
4. fails if `wrangler.jsonc` still declares an R2 binding.

Run TypeScript type-checking and the contract check before publishing. After deployment, query the remote MCP endpoint and require exactly 97 advertised tools with none of the removed names.

## Deployment and replacement

Publish the reduced source to the user's GitHub repository, deploy it through Cloudflare's Git integration, obtain its `workers.dev` MCP endpoint, and replace the existing `mcp-memory` URL in Claude Desktop. Restart Claude Desktop and query the configured endpoint again to verify the replacement.

## Security note

The upstream server identifies users by the URL path and does not provide OAuth. The generated user ID must be treated as a secret. Cloudflare infrastructure passthrough tools remain registered but require separate Cloudflare API credentials to function.
