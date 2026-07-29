# MCP Memory Access-Protected Management Console Design

## Goal

Replace the documentation-only root with a private, single-owner control plane for MCP Memory. The Worker must require Cloudflare Access for every browser, REST, static-asset, and MCP/SSE request. The root presents an option menu; the memory workspace provides safe tenant-scoped create, read, update, and delete operations.

## Scope

This design changes the user-facing root and adds browser management of existing memory records. It preserves the current D1, KV, Vectorize, MCP, and tenant-scoped REST contracts. It does not add a second database, a new public hostname, browser-side identity storage, analytics, or a new authorization model based on caller-controlled tenant IDs.

The first Access policy allows only the owner's configured Cloudflare Access identity. Future collaborators are outside this release and require an explicit policy and tenant-authorization design.

## Security Boundary

Cloudflare Access is the primary edge boundary for the complete `workers.dev` origin. The production policy permits only the owner. Access protects the root, `/console`, `/docs`, platform and tenant health endpoints, REST memory endpoints, and `/{userId}/sse`.

The Worker adds a second, independent boundary. A Hono middleware runs before rate limiting, database initialization, static assets, REST handlers, and MCP mounting. It reads `Cf-Access-Jwt-Assertion` and validates the JWT signature, issuer, and audience with the Access team JWK set. The Worker requires two production configuration values:

- `ACCESS_TEAM_DOMAIN`: the HTTPS Cloudflare Access team domain, used as JWT issuer and JWK source.
- `ACCESS_AUD`: the Access application audience tag for this Worker.

If either configuration value is missing, the header is absent, or validation fails, the Worker returns a generic `403` response and does not disclose token, tenant, database, or policy information. It never logs JWTs or authorization headers. The verified identity is not mapped to a tenant in this release: the Access allow policy has a single owner, and tenant selection remains an in-memory workspace scope. Verified Access service tokens remain compatible with MCP clients because the middleware authorizes valid audience/issuer claims rather than requiring an email claim.

The UI sends same-origin requests only. The Access browser session is handled by Cloudflare; the UI never receives, stores, or displays an Access token. Tenant IDs stay in the current page state only: they are not put in query strings, local storage, or cookies.

## Route and Asset Layout

The root becomes the authenticated option menu. The Worker explicitly maps the following static pages through the existing `ASSETS` binding:

| Path | Asset | Purpose |
| --- | --- | --- |
| `/` | `static/index.html` | Start menu |
| `/console` | `static/console.html` | Tenant-scoped memory workspace |
| `/docs` | `static/docs.html` | Existing developer reference |

The Worker retains `assets.run_worker_first: true`. The explicit static routes must remain registered before every parameterized tenant route and cannot intercept `/{userId}/sse` or the existing REST paths.

The existing developer reference moves without semantic or safety-content loss. Its dependency-free/no-browser-fetch contract remains attached to `docs.html`. The console is intentionally different: it uses same-origin `fetch` calls to the protected REST API.

## Start Menu

The root page provides four options:

1. **Manage memories** — opens `/console`.
2. **Connect an AI** — opens the relevant connection section in `/docs`.
3. **Developer reference** — opens `/docs`.
4. **Service health** — opens the operations section in `/docs`; it does not make a background request.

The menu presents the authenticated owner with a clear entry point instead of treating the technical reference as a management interface. It contains no tenant data and no destructive action.

## Memory Workspace

`/console` opens with a tenant selector and no data loaded. Entering a tenant ID and selecting **Load workspace** requests the existing `/{userId}/health` and `/{userId}/memories` endpoints over the same origin. Changing the tenant clears the current list and detail state before the next request completes.

The workspace contains:

- A tenant summary with total, embedded, pending, and suppressed counts from the tenant index.
- Refresh, client-side text search, category filter, and layer filter controls.
- A memory list showing content preview, category, layer, tags, confidence, salience, pin state, and creation time.
- An accessible detail/edit panel for one selected memory.
- A new-memory form using the current REST create contract.
- Explicit save and cancel behavior for edits using the existing REST update contract.
- A destructive delete confirmation that identifies the selected record and requires an explicit second action before the existing REST delete call is sent.
- Visible loading, empty, success, and generic tenant-safe error states with polite live announcements.

The initial release loads the REST list limit supported by the existing endpoint and filters it in the browser. It does not claim global full-text search, pagination, or multi-user collaboration. Those need dedicated API work in a later release.

## Worker and UI Components

- `src/access.ts` supplies the testable Access-token verification boundary and safe `403` response behavior.
- `src/index.ts` installs the Access middleware as the first application middleware, adds the three explicit static routes, and retains the existing memory and MCP handlers.
- `static/index.html` becomes the option menu.
- `static/console.html` provides the management workspace with embedded CSS and JavaScript, semantic forms, keyboard focus, reduced-motion support, and no third-party dependencies.
- `static/docs.html` preserves the existing technical reference.
- `worker-configuration.d.ts` is regenerated from Wrangler configuration after the new runtime bindings are declared.

The Access audience and team-domain configuration is environment-specific and never committed as a value. Runtime types are generated rather than hand-written.

## Error Handling

Invalid Access configuration and Access JWT failures fail closed before any application operation. REST errors remain generic in the console. A failed create, update, or delete leaves the visible list unchanged until the next successful refresh. Delete confirmation cannot be bypassed by keyboard submission. The UI treats network errors, `403`, `404`, `429`, and `5xx` responses as operation failures without exposing response bodies that may contain internal detail.

## Validation

Tests cover the Access middleware for missing configuration, missing header, invalid signature, wrong audience, and valid verified claims. Routing tests prove Access executes before static, REST, and MCP handlers, while preserving `run_worker_first` precedence. Static tests distinguish the no-fetch developer reference from the authenticated console and assert the root menu links.

Console tests cover request construction, tenant-state clearing, filter behavior, non-destructive cancel paths, and delete confirmation before mutation. The full project suite, tool-surface snapshot, TypeScript check, Wrangler dry run, and Access-protected live root verification must pass before deployment.

## Safe Rollout

1. Create the Cloudflare Access application and single-owner policy for the production Worker without changing public routing.
2. Record the Access team domain and application audience in Worker configuration using secrets or environment-specific deployment variables; do not commit values.
3. Deploy the JWT-verifying Worker. Before edge Access is enabled, its missing/invalid-token behavior is fail-closed, producing a temporary deny state rather than exposing memory data.
4. Enable Cloudflare Access for the production `workers.dev` route and attach the single-owner policy.
5. Create and authorize a dedicated Access service token for each MCP client that cannot complete a browser Access session, then update only that client's configuration.
6. Verify the owner browser session can reach the root, console, docs, tenant health, and a harmless authenticated read. Verify an unauthenticated request is denied. Do not create, edit, or delete production memories during rollout validation.

If the available Cloudflare credentials cannot administer Zero Trust Access, code work and local verification may proceed, but production rollout stops until the owner completes the Access dashboard configuration.
