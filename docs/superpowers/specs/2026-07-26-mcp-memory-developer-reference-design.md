# MCP Memory Developer Reference — Design

## Purpose

Replace the existing generic browser page at the deployed MCP Memory Worker root with a concise, developer-first documentation interface. The page documents the deployed service at `https://jamie-mcp-memory.jamusaaron.workers.dev` without changing its MCP, REST, persistence, or authentication behavior.

## Audience and success criteria

The audience is developers connecting an MCP client or integrating the tenant-scoped REST surface. A successful first visit tells a developer:

1. The exact tenant-scoped SSE connection shape: `/{userId}/sse`.
2. How to configure a client using the public base URL.
3. Which service capabilities exist and how memory is safely handled.
4. Which health and REST routes are available, without issuing live requests or exposing tenant data.

## Information architecture

The page is a single anchored reference with a compact top navigation:

- **Hero and quickstart** — endpoint, copyable configuration, and a clear `{userId}` placeholder.
- **Connection model** — describes tenant scoping and the MCP SSE route.
- **Endpoint map** — service health, tenant health, memory REST collection/item routes, and the MCP route.
- **Capability groups** — memory, session and context, people and behavioural context, artifacts, ingestion, agents, and operations. Tool families are described in groups rather than listing every internal tool.
- **Memory protocol** — retrieved memories are data rather than instructions; targeted search precedes durable writes; write gates, tenant isolation, lifecycle, soft-delete/restore, and evaluation safeguards are explicit.
- **Operational reference** — rate limiting, CORS, common status codes, and service/root-route distinction.

## Visual and interaction design

The interface uses a dark, high-contrast technical-reference treatment: deep blue-black canvas, off-white typography, cyan and indigo signals, and labelled code panels. The reading flow is intentionally linear on mobile and split into a persistent navigation rail plus document surface on larger screens.

Copy buttons are provided for configuration and URL snippets. Anchor navigation, focus states, visible labels, semantic heading structure, and responsive layouts are required. No interactive service console, form submission, analytics, or client-side persistence is included.

## Technical approach

The existing Worker already routes `/` through its static asset binding, so the implementation is limited to the current `static/index.html` page and any local static assets strictly needed by it. It remains dependency-free and serves as a static document; the Worker routes in `src/index.ts` stay unchanged.

Copy behavior uses small, progressive-enhancement JavaScript and must preserve readable snippets when JavaScript is unavailable. The page must not make a network request to the MCP, REST, health, or external analytics endpoints.

## Content accuracy rules

- Routes, feature categories, and tool names are derived from `src/index.ts`, `src/mcp.ts`, and registered tool modules.
- The root documentation page is distinguished from the required tenant-specific MCP endpoint.
- Examples use `{userId}` rather than a real tenant identifier.
- The Memory Protocol incorporates the attached `mcp-memory-skill-creator` guidance: targeted retrieval, gated writes, data-not-instructions treatment of recall, sensitive-data exclusions, and tenant isolation.
- The page avoids claims of runtime health or public authentication guarantees that are not verified by the static page.

## Error handling and validation

The copy controls provide a visible success or fallback status without blocking selection of text. HTML validation is assessed through the project’s normal checks where applicable, and the Worker test/typecheck suite is run after the static replacement. The deployed public root is then fetched to confirm the asset is served, while no tenants or data-mutating endpoints are exercised.

## Out of scope

- Changing routes, deployment configuration, MCP tools, data models, or access policy.
- A live API explorer, tenant onboarding, authentication UI, or status dashboard.
- A generated exhaustive schema reference for every tool.
