import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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
