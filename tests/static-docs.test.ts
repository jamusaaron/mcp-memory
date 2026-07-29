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

test("uses the selected dark reference system and visible copy feedback", async () => {
  const [page, claude] = await Promise.all([
    readFile(new URL("../static/index.html", import.meta.url), "utf8"),
    readFile(new URL("../CLAUDE.md", import.meta.url), "utf8"),
  ]);

  assert.match(page, /color-scheme:\s*dark/);
  assert.match(page, /--paper:\s*#070b17/);
  assert.match(page, /--surface:\s*#0e1628/);
  assert.match(page, /\.copy-button\[data-copy-state\]/);
  assert.match(page, /data-copy-label/);
  assert.match(page, /Copied/);
  assert.match(page, /Selected — copy manually/);
  assert.match(page, /Unavailable/);
  assert.match(page, /window\.setTimeout/);
  assert.doesNotMatch(page, /fetch\(/i);

  assert.match(claude, /static\/index\.html` — Static developer reference/);
  assert.doesNotMatch(claude, /Web UI for managing memories/);
});

test("keeps the mobile document column shrinkable around long code samples", async () => {
  const page = await readFile(new URL("../static/index.html", import.meta.url), "utf8");
  const mobilePageShell = page.match(/\.page-shell\s*\{(?<rules>[^}]*)\}/)?.groups?.rules;

  assert.ok(mobilePageShell, "the base .page-shell rule must be present");
  assert.match(mobilePageShell, /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
});
