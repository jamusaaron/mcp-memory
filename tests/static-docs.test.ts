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

test("documents the trusted multi-agent workflow and decision boundary", async () => {
  const page = await readFile(new URL("../static/index.html", import.meta.url), "utf8");

  assert.match(page, /id="multi-agent-workflows"/);
  for (const role of [
    "evidence",
    "user_intent",
    "safety",
    "privacy",
    "strategy",
    "operations",
    "adversarial_review",
  ]) {
    assert.match(page, new RegExp(`<code>${role}</code>`));
  }
  assert.match(page, /at least five approvals and zero\s+escalations/i);
  assert.match(page, /No external action is triggered/i);
  assert.match(
    page,
    /actor labels are caller-supplied audit metadata, not authenticated identity or authorization/i,
  );
});
