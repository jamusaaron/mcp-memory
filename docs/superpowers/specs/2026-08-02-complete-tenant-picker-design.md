# Complete tenant picker and console refresh

## Goal

Make the private memory console immediately usable: present every tenant that is known to the private D1 store in one native dropdown, load its MCP workspace when selected, and make the selection and loading states clear on desktop and mobile.

## Tenant discovery

There is no tenant registry table. A tenant is therefore *known* when its `userId` occurs in any tenant-scoped D1 table. The private `GET /tenants` route will return the full union of those IDs, with the existing memory count and latest-memory timestamp when present. It will not return tenant content or query values.

The query must include the legacy tables (`memories`, people/profile/session/agent tables) and the migrated artifact, profile-fact, coordination, and council tables. A tenant with records but no memories appears with `memoryCount: 0` and `lastUpdated: null`. A tenant with no data anywhere cannot be discovered and remains supported by the manual-ID fallback.

## Console interaction

The tenant selector is the primary control. Selecting a non-empty option immediately clears stale state, marks the selector busy, and requests the selected tenant's existing `/:userId/workspace` endpoint. It remains possible to enter a tenant ID manually for a tenant not yet known to D1; the explicit Load button only serves that fallback.

The dropdown displays the tenant ID and its memory count. The visible tenant count, a refresh button, an active-selection summary, and distinct loading/success/error status messages remove the ambiguity of the current form. A changed selection supersedes any older in-flight load.

## Visual refresh

Keep the existing dark, technical palette and native controls, but turn the left-side form into a compact **Tenant workspace** control panel. The active tenant is shown in the workspace header; the selector has a clear label, helper text, refresh control, and selected state. On small screens the control panel remains first and full-width, with controls large enough for touch.

No live tenant data is embedded in static HTML. The console keeps a single tenant in browser state and uses the existing MCP-backed workspace route for reads. Existing memory create/edit/delete routes remain unchanged.

## Safety and validation

- `/tenants` remains behind the existing access middleware and returns IDs, counts, and timestamps only.
- `assets.run_worker_first` and `/{userId}/sse` remain unchanged.
- The UI must fail closed: discovery errors retain manual entry; workspace errors do not render partial data.
- Tests cover the complete discovery query, dropdown label/count helpers, immediate-load event wiring, and no regression in authentication or MCP routes.
