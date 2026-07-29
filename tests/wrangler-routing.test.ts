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
});

test("denies every Worker path before assets, REST, or MCP dispatch", async () => {
	let assetFetches = 0;
	let mcpDispatches = 0;
	const app = createApp(async () => {
		mcpDispatches += 1;
		return new Response("unexpected MCP response");
	});
	const env = {
		ASSETS: {
			fetch: async () => {
				assetFetches += 1;
				return new Response("unexpected asset response");
			},
		},
	} as Env;

	for (const pathname of ["/", "/tenant/memories", "/tenant/sse"]) {
		const response = await app.fetch(
			new Request(`https://example.test${pathname}`),
			env,
			{} as ExecutionContext,
		);
		assert.equal(response.status, 403, `${pathname} must be denied without Access`);
		assert.equal(await response.text(), "Access denied");
	}

	assert.equal(assetFetches, 0, "the Access guard must run before static assets");
	assert.equal(mcpDispatches, 0, "the Access guard must run before MCP dispatch");
});
