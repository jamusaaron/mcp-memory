# Same-Site Access Gate Design

## Goal

Replace the failing cross-domain Cloudflare Access browser handoff with a same-site signed-session gate so Jamie can reach the private MCP Memory console from Safari while every Worker route remains authenticated.

## Context

Safari successfully completes the Cloudflare Access email-code login, but loops before the Worker receives the request. The account has no active Cloudflare zone for a custom domain, so the existing `workers.dev` hostname cannot be moved to a domain-local Access application. The replacement must preserve privacy for the console, REST API, and MCP transport.

## Selected design

The Worker will become the authentication boundary.

- A new `APP_ACCESS_KEY` Worker secret is a high-entropy private key held only by Jamie.
- `GET /auth/login` serves a small inline login page. `POST /auth/session` verifies the submitted key with a fixed-length HMAC comparison and creates a signed, eight-hour `__Host-mcp-memory` session cookie.
- Session cookies are signed using the existing `COOKIE_ENCRYPTION_KEY`; they are `Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`, and never contain the access key.
- All non-auth routes require either a valid session cookie (browser use) or `Authorization: Bearer <APP_ACCESS_KEY>` (MCP/API clients). Unauthenticated browser navigation redirects to `/auth/login`; API and MCP requests receive a plain `401` response.
- Cloudflare Access will be changed to an edge bypass only after the Worker gate and secret are deployed. This removes the broken redirect while the Worker remains the sole enforcement point.
- `Cache-Control: no-store` is applied to login and authentication responses. Logout clears the same cookie.

## Alternatives rejected

1. Keep retrying Cloudflare Access configuration. Access logs prove authentication succeeds, but Worker logs prove Safari never reaches the Worker after login.
2. Move to a custom domain. There are no active zones in the account, so this cannot be completed without acquiring and onboarding a domain.
3. Make the console public. This violates the agreed `Just me` boundary.

## Verification

- Unit tests prove missing, malformed, expired, and tampered sessions are denied; a signed session and Bearer key are accepted; logout clears the cookie.
- Route integration tests prove static assets, REST, and MCP dispatch remain inaccessible before authentication.
- Production verification tests unauthenticated browser navigation reaches the Worker-owned login page, authenticated requests receive the console, and no Cloudflare Access redirect occurs.

