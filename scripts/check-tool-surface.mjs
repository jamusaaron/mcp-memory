import fs from "node:fs";
import path from "node:path";

const activeFiles = [
	"src/tools/memory.ts",
	"src/tools/daily-recall.ts",
	"src/tools/people.ts",
	"src/tools/uncertainty.ts",
	"src/tools/session.ts",
	"src/tools/context-docs.ts",
	"src/tools/blobs.ts",
	"src/tools/behavioral.ts",
	"src/tools/ingestion.ts",
	"src/tools/ai-agents.ts",
	"src/tools/agent-orchestrator.ts",
	"src/tools/health.ts",
	"src/tools/infra.ts",
];
const forbidden = new Set([
	// Old R2-era tool names (replaced by context_doc_* / blob_* / storage_status)
	"read_static_file",
	"update_static_file",
	"delete_static_file",
	"list_static_files",
	"r2_bucket_create",
	"r2_bucket_get",
	"r2_bucket_delete",
	"r2_buckets_list",
]);
const EXPECTED_TOOLS = 139;
const activeSources = new Map(
	activeFiles.map((file) => [file, fs.readFileSync(path.resolve(file), "utf8")]),
);
const names = activeFiles.flatMap((file) => {
	const source = activeSources.get(file);
	return [...source.matchAll(/server\.(?:tool|registerTool)\(\s*["']([^"']+)["']/g)].map((match) => match[1]);
});
const errors = [];
for (const name of forbidden) {
	if (names.includes(name)) errors.push(`forbidden tool registered: ${name}`);
}
if (names.length !== EXPECTED_TOOLS)
	errors.push(`expected ${EXPECTED_TOOLS} tools, found ${names.length}: ${names.join(", ")}`);
if (new Set(names).size !== names.length) errors.push("duplicate tool names detected");

// R2 must be optional — code may reference env.R2 but must not hard-require it
const staticCtx = fs.readFileSync("src/utils/static-context.ts", "utf8");
if (!staticCtx.includes("hasR2") || !staticCtx.includes("env.KV")) {
	errors.push("static-context must support dual R2/KV backends");
}
const wrangler = fs.readFileSync("wrangler.jsonc", "utf8");
// Optional: r2_buckets only when product is enabled; either state is valid
// Only count active JSON keys (not comments). Strip // comments first.
const wranglerActive = wrangler.replace(/\/\/.*$/gm, "");
const hasR2Binding = /"r2_buckets"\s*:/.test(wranglerActive);
const types = fs.readFileSync("worker-configuration.d.ts", "utf8");
if (hasR2Binding && !/R2\??\s*:\s*R2Bucket/.test(types)) {
	errors.push("wrangler has R2 binding but worker-configuration.d.ts lacks R2");
}
if (!hasR2Binding && !/R2\?\s*:\s*R2Bucket/.test(types)) {
	errors.push("without wrangler R2 binding, Env.R2 should be optional (R2?: R2Bucket)");
}
const indexSource = fs.readFileSync("src/index.ts", "utf8");
if (!indexSource.includes("RATE_LIMITER.limit"))
	errors.push("rate limiter binding is not enforced");
const mcpSource = fs.readFileSync("src/mcp.ts", "utf8");
if (!mcpSource.includes("registerBlobTools")) {
	errors.push("blob tools not registered in mcp.ts");
}
if (errors.length) {
	console.error(errors.join("\n"));
	process.exit(1);
}
console.log(
	`Tool surface verified: ${names.length} tools; R2 binding ${hasR2Binding ? "ON" : "OFF (optional dual-backend ready)"}`,
);
