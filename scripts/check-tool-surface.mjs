import fs from "node:fs";
import path from "node:path";

const activeFiles = [
	"src/tools/memory.ts",
	"src/tools/people.ts",
	"src/tools/uncertainty.ts",
	"src/tools/session.ts",
	"src/tools/behavioral.ts",
	"src/tools/ingestion.ts",
	"src/tools/ai-agents.ts",
	"src/tools/health.ts",
	"src/tools/infra.ts",
];
const forbidden = new Set([
	"read_static_file",
	"update_static_file",
	"delete_static_file",
	"list_static_files",
	"r2_bucket_create",
	"r2_bucket_get",
	"r2_bucket_delete",
	"r2_buckets_list",
]);
const activeSources = new Map(
	activeFiles.map((file) => [file, fs.readFileSync(path.resolve(file), "utf8")]),
);
const names = activeFiles.flatMap((file) => {
	const source = activeSources.get(file);
	return [...source.matchAll(/server\.tool\(\s*["']([^"']+)["']/g)].map((match) => match[1]);
});
const errors = [];
for (const name of forbidden) {
	if (names.includes(name)) errors.push(`forbidden tool registered: ${name}`);
}
if (names.length !== 97) errors.push(`expected 97 tools, found ${names.length}`);
if (new Set(names).size !== names.length) errors.push("duplicate tool names detected");
for (const [file, source] of activeSources) {
	if (/\bR2\b|utils\/r2|R2_BUCKET/.test(source)) {
		errors.push(`active R2 dependency remains: ${file}`);
	}
}
const mcpSource = fs.readFileSync("src/mcp.ts", "utf8");
if (mcpSource.includes("registerStaticFileTools")) {
	errors.push("static-file tools remain registered");
}
const wrangler = fs.readFileSync("wrangler.jsonc", "utf8");
if (/"r2_buckets"\s*:/.test(wrangler)) errors.push("R2 binding remains configured");
const indexSource = fs.readFileSync("src/index.ts", "utf8");
if (!indexSource.includes("RATE_LIMITER.limit"))
	errors.push("rate limiter binding is not enforced");
for (const deadFile of [
	"src/tools/static-files.ts",
	"src/utils/r2.ts",
	"scripts/seed-jamie-memory.mjs",
]) {
	if (fs.existsSync(deadFile))
		errors.push(`dead or deployment-specific file remains: ${deadFile}`);
}
const generatedTypes = fs.readFileSync("worker-configuration.d.ts", "utf8");
if (/interface Env \{[\s\S]*?\n\s*R2:\s*R2Bucket;/.test(generatedTypes)) {
	errors.push("generated Cloudflare.Env still declares an R2 binding");
}
const claudeGuide = fs.readFileSync("CLAUDE.md", "utf8");
if (/105 tools|Cloudflare R2|src\/tools\/static-files\.ts|src\/utils\/r2\.ts/.test(claudeGuide)) {
	errors.push("CLAUDE.md still describes the removed R2/105-tool architecture");
}
const readme = fs.readFileSync("README.md", "utf8");
if (!readme.includes("CLOUDFLARE_API_TOKEN") || !readme.includes("CLOUDFLARE_ACCOUNT_ID")) {
	errors.push("README.md does not document optional Cloudflare admin credentials");
}
if (errors.length) {
	console.error(errors.join("\n"));
	process.exit(1);
}
console.log(`Tool surface verified: ${names.length} tools, no R2 dependency`);
