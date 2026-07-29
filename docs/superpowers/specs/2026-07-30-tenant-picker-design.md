# Private tenant picker

## Goal

Make stored tenants selectable in the private memory workspace without exposing tenant data or changing the MCP transport.

## Design

The Worker will expose an authenticated `GET /tenants` route before the dynamic `/:userId/*` routes. It returns a bounded, deterministic list built from the `memories` table:

```json
{
  "success": true,
  "tenants": [
    { "id": "<tenant-id>", "memoryCount": 193, "lastUpdated": "<ISO timestamp>" }
  ]
}
```

The route is covered by the existing same-site session or private Bearer-key middleware. It returns no memory content, profile data, artifact content, agent data, or internal error detail. It sorts the selectable tenants by most recent memory update, then ID, and caps the result to a safe UI-sized list.

The console replaces its sole tenant-ID field with a tenant `<select>`. Each option displays the tenant ID and memory count. It is disabled while the list loads and has a clear empty state when no memory tenants exist. A collapsed “Enter tenant ID manually” fallback retains the existing power-user path and does not load a tenant automatically.

## Data flow

1. A signed-in console opens and requests `/tenants` with same-origin credentials.
2. The Worker returns the authenticated tenant summaries from D1.
3. The console populates the selector without loading memory content.
4. Selecting an option and submitting uses the existing `/:userId/health` and `/:userId/memories` routes.
5. If tenant discovery fails, the console shows a bounded error and manual entry remains available.

## Safety and compatibility

- The route is private; it is not an MCP tool and does not alter MCP transport behavior.
- The existing `/{userId}/sse` documentation placeholder stays generic; the selector is the safe UI path for choosing a stored tenant.
- The accidental encoded placeholder tenant has already been merged and will not appear because it no longer has memory records.
- No tenant is selected or loaded by default.

## Tests and verification

- Add a regression test for the tenant-summary query: deterministic ordering, counts, and no content fields.
- Add a routing test proving an unauthenticated API request to `/tenants` is rejected before the handler.
- Add console tests for tenant option labels and the manual-entry fallback.
- Run focused tests, `npm run test:all`, TypeScript compilation, a Wrangler dry-run, production deploy, and authenticated live checks of `/tenants` and the console.
