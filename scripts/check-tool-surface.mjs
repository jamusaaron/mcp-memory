import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const activeFiles = [
	"src/tools/memory.ts",
	"src/tools/daily-recall.ts",
	"src/tools/people.ts",
	"src/tools/uncertainty.ts",
	"src/tools/session.ts",
	"src/tools/context-docs.ts",
	"src/tools/coordination.ts",
	"src/tools/blobs.ts",
	"src/tools/behavioral.ts",
	"src/tools/derived-artifacts.ts",
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
export const EXPECTED_TOOL_NAMES = [
	"accounts_list",
	"add_person",
	"agent_handoff",
	"agent_register_presence",
	"agent_runs_list",
	"agent_task_claim",
	"agent_task_complete",
	"agent_task_create",
	"agent_task_fail",
	"agent_task_list",
	"agents_dashboard",
	"ai_agents_list",
	"ai_note_delete",
	"ai_note_list",
	"ai_note_read",
	"ai_note_write",
	"ai_notes_cross_check",
	"analyze_patterns",
	"append_session_intent",
	"append_session_log",
	"apply_pending_profile_updates",
	"ask_user",
	"audit_profile_health",
	"auto_triage",
	"backfill_embeddings",
	"backfill_emotion_weights",
	"batch_write_memories",
	"behavioral_model",
	"brief_for_agent",
	"build_personality",
	"bulk_tag_memories",
	"check_write_activity",
	"connection_map",
	"coordination_brief",
	"coordination_handoff_list",
	"coordination_handoff_review",
	"coordination_handoff_submit",
	"coordination_task_claim",
	"coordination_task_heartbeat",
	"coordination_task_release",
	"council_decide",
	"council_decision_get",
	"council_proposal_create",
	"d1_database_create",
	"d1_database_delete",
	"d1_database_get",
	"d1_database_query",
	"d1_databases_list",
	"delete_blob",
	"delete_context_doc",
	"delete_person",
	"dismiss_uncertainty",
	"drafting_agent",
	"edit_memory",
	"embed_memory",
	"emotional_context",
	"evidence_agent",
	"export_memories",
	"extract_profile_updates_from_text",
	"forget_memory",
	"fulltext_search",
	"generate_pattern_report",
	"get_derived_artifact",
	"get_high_salience",
	"get_living_summary",
	"get_memory_context",
	"get_memory_index",
	"get_person_profile",
	"get_personality",
	"get_personality_mode",
	"get_session_brief",
	"get_suppressed_memories",
	"health_check",
	"hyperdrive_config_delete",
	"hyperdrive_config_edit",
	"hyperdrive_config_get",
	"hyperdrive_configs_list",
	"import_memories",
	"ingest_transcript",
	"kv_namespace_create",
	"kv_namespace_delete",
	"kv_namespace_get",
	"kv_namespace_update",
	"kv_namespaces_list",
	"list_blobs",
	"list_context_docs",
	"list_derived_artifacts",
	"list_memories",
	"list_open_uncertainties",
	"list_pending_profile_updates",
	"list_people",
	"list_pinned_memories",
	"list_reverify_queue",
	"list_transcripts",
	"memory_agent_ask",
	"memory_db_readonly_query",
	"memory_timeline",
	"migrate_docs_to_r2",
	"migrate_pages_to_workers_guide",
	"morning_agent",
	"multi_agent_debate",
	"personality_feedback",
	"pin_memory",
	"promote_memory",
	"propose_profile_updates",
	"query_memories",
	"query_memories_by_date",
	"read_blob",
	"read_context_doc",
	"rebuild_living_summary",
	"rebuild_profiles",
	"rebuild_self_profile",
	"recall",
	"recall_decisions",
	"record_observation",
	"record_user_answer",
	"reject_pending_profile_update",
	"remember",
	"remember_decision",
	"research_agent",
	"restore_derived_artifact",
	"restore_memory",
	"review_derived_artifact",
	"run_agent",
	"run_consolidation",
	"run_decay_sweep",
	"search_by_tag",
	"search_cloudflare_documentation",
	"search_people",
	"session_audit",
	"session_close",
	"session_list",
	"set_active_account",
	"smart_context",
	"storage_status",
	"store_blob",
	"strategy_agent",
	"style_check_agent",
	"submit_inbound",
	"suppress_memory",
	"topic_digest",
	"unpin_memory",
	"update_context_current",
	"update_person",
	"update_person_profile",
	"update_profile",
	"verify_memory",
	"what_changed",
	"workers_get_worker",
	"workers_get_worker_code",
	"workers_list",
	"write_context_doc",
	"write_memory",
];
const activeSources = new Map(
	activeFiles.map((file) => [file, fs.readFileSync(path.resolve(file), "utf8")]),
);

export function extractRegisteredToolNames(source, fileName = "tools.ts") {
	const sourceFile = ts.createSourceFile(
		fileName,
		source,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	const names = [];
	function visit(node) {
		if (
			ts.isCallExpression(node) &&
			ts.isPropertyAccessExpression(node.expression) &&
			ts.isIdentifier(node.expression.expression) &&
			node.expression.expression.text === "server" &&
			(node.expression.name.text === "tool" || node.expression.name.text === "registerTool")
		) {
			const name = node.arguments[0];
			if (name && ts.isStringLiteralLike(name)) names.push(name.text);
		}
		ts.forEachChild(node, visit);
	}
	visit(sourceFile);
	return names;
}

const names = activeFiles.flatMap((file) =>
	extractRegisteredToolNames(activeSources.get(file), file),
);
const errors = [];
const parserFixture = `
	// server.tool("commented-out");
	const decoy = 'server.registerTool("string-literal")';
	server.tool("fixture-tool");
	server.registerTool("fixture-register-tool");
`;
const fixtureNames = extractRegisteredToolNames(parserFixture, "tool-surface-fixture.ts");
if (
	fixtureNames.length !== 2 ||
	fixtureNames[0] !== "fixture-tool" ||
	fixtureNames[1] !== "fixture-register-tool"
) {
	errors.push(`tool parser self-test failed: ${fixtureNames.join(", ")}`);
}
for (const name of forbidden) {
	if (names.includes(name)) errors.push(`forbidden tool registered: ${name}`);
}
const actual = new Set(names);
const expected = new Set(EXPECTED_TOOL_NAMES);
const missing = EXPECTED_TOOL_NAMES.filter((name) => !actual.has(name));
const unexpected = [...actual].filter((name) => !expected.has(name)).sort();
if (missing.length || unexpected.length) {
	errors.push(
		`tool-name snapshot mismatch\nmissing: ${missing.join(", ") || "none"}\nunexpected: ${
			unexpected.join(", ") || "none"
		}`,
	);
}
if (EXPECTED_TOOL_NAMES.length !== 153) {
	errors.push(`expected snapshot to contain 153 names, found ${EXPECTED_TOOL_NAMES.length}`);
}
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
if (!mcpSource.includes("registerCoordinationTools")) {
	errors.push("coordination tools not registered in mcp.ts");
}
if (errors.length) {
	console.error(errors.join("\n"));
	process.exit(1);
}
console.log(
	`Tool surface verified: exact ${EXPECTED_TOOL_NAMES.length}-name snapshot; R2 binding ${
		hasR2Binding ? "ON" : "OFF (optional dual-backend ready)"
	}`,
);
