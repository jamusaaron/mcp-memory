import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("publishes a tenant-scoped, dependency-free MCP reference", async () => {
  const page = await readFile(new URL("../static/index.html", import.meta.url), "utf8");

  assert.match(page, /https:\/\/jamie-mcp-memory\.jamusaaron\.workers\.dev/);
  assert.match(page, /\{userId\}\/sse/);
  assert.match(page, /id="memory-protocol"/);
  assert.match(page, /aria-live="polite"/);
  assert.doesNotMatch(page, /cdn\.jsdelivr|tailwindcss|google-analytics|fetch\(/i);
});
