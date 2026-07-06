import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);

function versionTuple(version: string): [number, number, number] {
	const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
	return [major, minor, patch];
}

function atLeast(version: string, minimum: string): boolean {
	const current = versionTuple(version);
	const required = versionTuple(minimum);
	return current.some((part, index) => part > required[index] && current.slice(0, index).every((value, prior) => value === required[prior])) || current.every((part, index) => part === required[index]);
}

test("Cloudflare Agents supports strict MCP transport connection handling", async () => {
	const packageJson = JSON.parse(await readFile(new URL("../node_modules/agents/package.json", import.meta.url), "utf8"));
	assert.ok(
		atLeast(packageJson.version, "0.2.0"),
		`agents ${packageJson.version} connects the same MCP server twice; version 0.2.0 or newer is required`,
	);
});

test("Cloudflare Agents runtime peers resolve during Worker bundling", async () => {
	assert.match(require.resolve("ai"), /node_modules\/ai\//);
});
