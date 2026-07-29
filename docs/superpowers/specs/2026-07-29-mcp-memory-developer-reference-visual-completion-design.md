# MCP Memory Developer Reference — Visual Completion Design

## Goal

Complete the existing documentation-only reference at the Worker root as the approved dark, high-contrast technical interface. Preserve its source-grounded developer content, tenant-safe examples, and static delivery model.

## Audience and boundary

The page serves technical users who need to connect an MCP client or understand the tenant-scoped REST surface. It is not a memory-management application, onboarding flow, authentication screen, API explorer, live health dashboard, or tenant console.

The page remains a static document. It must not make browser-side network requests to the Worker, MCP, REST, health, analytics, or third-party services. Examples use the literal `{userId}` placeholder; no actual tenant identifier is included.

## Selected approach

Use surgical visual conformance rather than a structural redesign:

- Retain the current information architecture: quickstart, connection, endpoints, capabilities, multi-agent workflow, memory protocol, and operations.
- Retain the current progressive copy controls and responsive reading flow.
- Replace the light visual system with the approved deep blue-black canvas, off-white text, cyan and indigo signals, and high-contrast code surfaces.
- Make copy results visibly apparent while retaining the existing assistive-technology announcements.

This avoids duplicating the existing reference or widening the user-authorized documentation-only scope.

## Visual system

Use local CSS custom properties to express a compact technical-reference system:

- **Canvas:** deep blue-black background with restrained cyan/indigo ambient gradients.
- **Content surfaces:** dark layered panels with visible but low-noise borders and elevation.
- **Typography:** off-white headings and body text, muted blue-gray supporting copy, cyan section labels, indigo links.
- **Code and endpoints:** near-black code panels with high-contrast monospace text, explicit transport and method badges, horizontal scrolling where necessary.
- **Focus and motion:** a distinct warm focus ring, `prefers-reduced-motion` protection, and no motion essential to comprehension.

The visual language is technical and legible rather than decorative: no external fonts, image assets, icon library, animation dependency, or glassy dashboard treatment.

## Layout and responsive behaviour

The page remains mobile-first:

- On narrow screens, the navigation is a horizontally scrollable section index followed by a single reading column.
- At the existing desktop breakpoint, navigation becomes a sticky document rail beside the reading surface.
- Cards, endpoint rows, code blocks, and protocol checklists maintain readable line lengths and avoid horizontal clipping except within deliberately scrollable code panels.
- The page maintains semantic landmarks, heading order, skip navigation, visible keyboard focus, and accessible labels.

## Copy-feedback interaction

Copy buttons continue to copy the associated configuration or URL text using progressive enhancement. Each action visibly changes its own button label/state to communicate one of these outcomes:

- `Copied` after a successful Clipboard API write.
- `Selected — copy manually` when the browser fallback selects text.
- `Unavailable` only if the target cannot be resolved.

The shared polite live region remains for assistive technology. Button feedback resets after a short, non-blocking interval and never requires network activity or browser storage.

## Content preservation and documentation correction

The implementation must preserve the existing route facts, safety framing, council decision boundary, and documentation-only stance. It must not introduce claims of live service health or authentication guarantees.

`CLAUDE.md` will be corrected so `static/index.html` is described as the developer reference instead of a memory-management UI.

## Verification strategy

Work test-first:

1. Extend the static-document contract with assertions for the dark reference tokens, copy-feedback contract, dependency-free/no-network guarantee, and documentation-only boundary.
2. Demonstrate the new assertions fail before changing the page.
3. Implement the smallest static-page and documentation changes that satisfy them.
4. Run focused static and routing tests, then the complete project gate (`npm run test:all`), TypeScript compilation, and a Wrangler dry run.
5. Inspect the deployed public root after deployment; do not exercise tenant routes or mutate memory data as part of UI verification.

## Acceptance criteria

- The public root remains a dependency-free, static developer reference served from the existing asset binding.
- The page uses the approved dark, high-contrast technical visual system at desktop and mobile sizes.
- All existing technical documentation sections and tenant placeholders remain intact.
- Copy actions visibly report success or fallback and continue to announce status accessibly.
- No browser-side `fetch`, external asset, analytics, tenant data, or live operational control is introduced.
- Static, routing, full project, typecheck, dry-run, and public-root validation gates pass.

## Non-goals

- Changing Worker routes, MCP tools, persistence, authentication, Access policy, or deployment architecture.
- Exposing a real tenant route, issuing browser-side service calls, or displaying tenant data.
- Adding an interactive API console, health dashboard, memory CRUD interface, or onboarding flow.
