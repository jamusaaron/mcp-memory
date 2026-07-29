import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createApp } from "../src/app";

test("routes MCP transport requests through the Worker before static assets", async () => {
	const configText = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
	const config = JSON.parse(
		configText.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""),
	);

	assert.equal(
		config.assets?.run_worker_first,
		true,
		"assets.run_worker_first must be true or /:userId/sse can return static HTML",
	);
	assert.equal(
		config.assets?.html_handling,
		"none",
		"routed HTML assets must not be redirected back to their canonical path",
	);
});

test("fetches routed HTML assets without browser-navigation headers", async () => {
	let assetRequest: Request | undefined;
	const app = createApp(async () => new Response("unexpected MCP response"));
	const env = {
		APP_ACCESS_KEY: "private-access-key",
		COOKIE_ENCRYPTION_KEY: "cookie-signing-key",
		ASSETS: {
			fetch: async (request: Request) => {
				assetRequest = request;
				return new Response("start menu", {
					headers: { "Content-Type": "text/html; charset=UTF-8" },
				});
			},
		},
	} as Env;

	const response = await app.fetch(
		new Request("https://example.test/", {
			headers: {
				Accept: "text/html",
				Authorization: "Bearer private-access-key",
			},
		}),
		env,
		{} as ExecutionContext,
	);

	assert.equal(response.status, 200);
	assert.equal(assetRequest?.url, "https://example.test/index.html");
	assert.equal(
		assetRequest?.headers.get("accept"),
		"application/octet-stream",
		"asset fetch must not trigger the platform's navigation canonicalization redirect",
	);
});

test("redirects unauthenticated browser navigation to the Worker login route", async () => {
	let assetFetches = 0;
	let mcpDispatches = 0;
	const app = createApp(async () => {
		mcpDispatches += 1;
		return new Response("unexpected MCP response");
	});
	const env = {
		APP_ACCESS_KEY: "private-access-key",
		COOKIE_ENCRYPTION_KEY: "cookie-signing-key",
		ASSETS: {
			fetch: async () => {
				assetFetches += 1;
				return new Response("unexpected asset response");
			},
		},
	} as Env;

	const response = await app.fetch(
		new Request("https://example.test/console?view=recent", { headers: { Accept: "text/html" } }),
		env,
		{} as ExecutionContext,
	);

	assert.equal(response.status, 302);
	assert.equal(response.headers.get("location"), "/auth/login?next=%2Fconsole%3Fview%3Drecent");
	assert.equal(assetFetches, 0, "the access gate must run before static assets");
	assert.equal(mcpDispatches, 0, "the access gate must run before MCP dispatch");
});

test("denies unauthenticated REST and MCP requests before their handlers", async () => {
	let assetFetches = 0;
	let mcpDispatches = 0;
	const app = createApp(async () => {
		mcpDispatches += 1;
		return new Response("unexpected MCP response");
	});
	const env = {
		APP_ACCESS_KEY: "private-access-key",
		COOKIE_ENCRYPTION_KEY: "cookie-signing-key",
		ASSETS: {
			fetch: async () => {
				assetFetches += 1;
				return new Response("unexpected asset response");
			},
		},
	} as Env;

	for (const pathname of ["/tenants", "/tenant/memories", "/tenant/sse"]) {
		const response = await app.fetch(
			new Request(`https://example.test${pathname}`, { headers: { Accept: "application/json" } }),
			env,
			{} as ExecutionContext,
		);
		assert.equal(response.status, 401, `${pathname} must be denied without a private session`);
		assert.equal(await response.text(), "Authentication required");
	}

	assert.equal(assetFetches, 0, "the access gate must run before static assets");
	assert.equal(mcpDispatches, 0, "the access gate must run before MCP dispatch");
});

test("serves the Worker-owned login page without invoking assets or MCP dispatch", async () => {
	let assetFetches = 0;
	let mcpDispatches = 0;
	const app = createApp(async () => {
		mcpDispatches += 1;
		return new Response("unexpected MCP response");
	});
	const env = {
		APP_ACCESS_KEY: "private-access-key",
		COOKIE_ENCRYPTION_KEY: "cookie-signing-key",
		ASSETS: {
			fetch: async () => {
				assetFetches += 1;
				return new Response("unexpected asset response");
			},
		},
	} as Env;

	const response = await app.fetch(
		new Request("https://example.test/auth/login", { headers: { Accept: "text/html" } }),
		env,
		{} as ExecutionContext,
	);

	assert.equal(response.status, 200);
	assert.match(await response.text(), /MCP Memory · Private sign in/);
	assert.equal(response.headers.get("cache-control"), "no-store");
	assert.equal(assetFetches, 0);
	assert.equal(mcpDispatches, 0);
});

test("exchanges the private key for a no-store session and clears it on logout", async () => {
	const app = createApp(async () => new Response("unexpected MCP response"));
	const env = {
		APP_ACCESS_KEY: "private-access-key",
		COOKIE_ENCRYPTION_KEY: "cookie-signing-key",
		ASSETS: { fetch: async () => new Response("login page") },
	} as Env;

	const denied = await app.fetch(
		new Request("https://example.test/auth/session", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ accessKey: "wrong-key", next: "/console" }),
		}),
		env,
		{} as ExecutionContext,
	);
	const accepted = await app.fetch(
		new Request("https://example.test/auth/session", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ accessKey: "private-access-key", next: "/console" }),
		}),
		env,
		{} as ExecutionContext,
	);
	const logout = await app.fetch(
		new Request("https://example.test/auth/logout"),
		env,
		{} as ExecutionContext,
	);

	assert.equal(denied.status, 401);
	assert.equal(accepted.status, 200);
	assert.deepEqual(await accepted.json(), { success: true, next: "/console" });
	assert.match(
		accepted.headers.get("set-cookie") ?? "",
		/^__Host-mcp-memory=[^;]+; Max-Age=28800; Path=\/; Secure; HttpOnly; SameSite=Strict$/,
	);
	assert.equal(accepted.headers.get("cache-control"), "no-store");
	assert.equal(logout.status, 302);
	assert.equal(logout.headers.get("location"), "/auth/login");
	assert.equal(
		logout.headers.get("set-cookie"),
		"__Host-mcp-memory=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Strict",
	);
});
