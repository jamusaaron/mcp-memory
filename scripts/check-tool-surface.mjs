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
const activeSources = new Map(activeFiles.map((file) => [
  file,
  fs.readFileSync(path.resolve(file), "utf8"),
]));
const names = activeFiles.flatMap((file) => {
  const source = activeSources.get(file);
  return [...source.matchAll(/server\.tool\(\s*["']([^"']+)["']/g)].map(
    (match) => match[1],
  );
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
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`Tool surface verified: ${names.length} tools, no R2 dependency`);
