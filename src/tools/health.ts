import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CloudflareApi } from "../utils/cloudflare-api";
import { getMemoryIndex, listPeople } from "../utils/db";
import { getLivingSummary, getKV } from "../utils/kv";
import { listStaticFiles } from "../utils/static-context";
import { toolError, toolText } from "../utils/tool-result";

export function registerHealthTools(server: McpServer, env: Env, userId: string) {
	server.tool(
		"health_check",
		"Run a comprehensive health check on all system components: D1 database, Vectorize index, KV cache, persistent context, Workers AI, and all active subsystems (behavioral, sessions, agent notes, uncertainties, transcripts). Returns per-component status with counts and diagnostics. Use this to verify the system is operational or to diagnose connectivity issues.",
		{},
		async () => {
			try {
				const checks: Record<string, string> = {};

				// ── Core infrastructure ──

				try {
					const index = await getMemoryIndex(userId, env);
					checks["D1 — Memories"] =
						`OK — ${index.total} total (${index.embedded} embedded, ${index.pending_embedding} pending backfill, ${index.suppressed} suppressed)`;
					checks["Category distribution"] = Object.entries(index.by_category)
						.filter(([, v]) => v > 0)
						.map(([k, v]) => `${k}: ${v}`)
						.join(", ") || "no memories yet";
					checks["Layer distribution"] = Object.entries(index.by_layer)
						.filter(([, v]) => v > 0)
						.map(([k, v]) => `${k}: ${v}`)
						.join(", ") || "no memories yet";
				} catch (e) {
					checks["D1 — Memories"] = `FAIL — ${String(e)}`;
				}

				try {
					const people = await listPeople(userId, env);
					checks["D1 — People"] = `OK — ${people.length} profiles tracked`;
				} catch (e) {
					checks["D1 — People"] = `FAIL — ${String(e)}`;
				}

				try {
					await env.VECTORIZE.query(new Array(1024).fill(0), {
						namespace: userId,
						topK: 1,
					});
					checks["Vectorize"] = "OK — reachable";
				} catch (e) {
					checks["Vectorize"] = `FAIL — ${String(e)}`;
				}

				try {
					await env.KV.get("__health_check__");
					checks["KV"] = "OK — reachable";
				} catch (e) {
					checks["KV"] = `FAIL — ${String(e)}`;
				}

				try {
					const files = await listStaticFiles(userId, env);
					checks["Persistent context"] = `OK — ${files.length} files (${
						files.join(", ") || "none"
					})`;
				} catch (e) {
					checks["Persistent context"] = `FAIL — ${String(e)}`;
				}

				try {
					const test = (await env.AI.run("@cf/baai/bge-m3", {
						text: "health check",
					})) as any;
					checks["Workers AI"] = test?.data?.[0]
						? "OK — reachable"
						: "FAIL — unexpected response";
				} catch (e) {
					checks["Workers AI"] = `FAIL — ${String(e)}`;
				}

				// ── Subsystem health ──

				try {
					const livingSummary = await getLivingSummary(userId, env);
					checks["Living summary (KV)"] = livingSummary
						? `OK — cached (${livingSummary.length} chars)`
						: "STALE — no cached summary; call rebuild_living_summary";
				} catch (e) {
					checks["Living summary (KV)"] = `FAIL — ${String(e)}`;
				}

				try {
					const obsResult = await env.DB.prepare(
						"SELECT COUNT(*) as count, MAX(created_at) as last FROM behavioral_observations WHERE userId=?",
					)
						.bind(userId)
						.first<{ count: number; last: string | null }>();
					checks["Behavioral observations"] = obsResult
						? `OK — ${obsResult.count} observations (last: ${obsResult.last ?? "never"})`
						: "OK — 0 observations";
				} catch (e) {
					checks["Behavioral observations"] = `FAIL — ${String(e)}`;
				}

				try {
					const notesResult = await env.DB.prepare(
						"SELECT COUNT(*) as count, MAX(updated_at) as last FROM ai_notes WHERE userId=?",
					)
						.bind(userId)
						.first<{ count: number; last: string | null }>();
					checks["AI agent notes"] = notesResult
						? `OK — ${notesResult.count} notes (last updated: ${notesResult.last ?? "never"})`
						: "OK — 0 notes";
				} catch (e) {
					checks["AI agent notes"] = `FAIL — ${String(e)}`;
				}

				try {
					const openQs = await env.DB.prepare(
						"SELECT COUNT(*) as count FROM uncertainties WHERE userId=? AND status='open'",
					)
						.bind(userId)
						.first<{ count: number }>();
					checks["Open uncertainties"] = openQs
						? openQs.count === 0
							? "OK — none pending"
							: `⚠️ ${openQs.count} unresolved questions`
						: "OK — 0 pending";
				} catch (e) {
					checks["Open uncertainties"] = `FAIL — ${String(e)}`;
				}

				try {
					const txResult = await env.DB.prepare(
						"SELECT COUNT(*) as total, SUM(CASE WHEN processed=0 THEN 1 ELSE 0 END) as pending FROM transcripts WHERE userId=?",
					)
						.bind(userId)
						.first<{ total: number; pending: number }>();
					checks["Transcript pipeline"] = txResult
						? `OK — ${txResult.total} total (${txResult.pending ?? 0} unprocessed)`
						: "OK — no transcripts";
				} catch (e) {
					checks["Transcript pipeline"] = `FAIL — ${String(e)}`;
				}

				try {
					const sessionResult = await env.DB.prepare(
						"SELECT COUNT(DISTINCT session_id) as count, MAX(created_at) as last FROM session_logs WHERE userId=?",
					)
						.bind(userId)
						.first<{ count: number; last: string | null }>();
					checks["Session logs"] = sessionResult
						? `OK — ${sessionResult.count} sessions (last activity: ${sessionResult.last ?? "never"})`
						: "OK — no sessions yet";
				} catch (e) {
					checks["Session logs"] = `FAIL — ${String(e)}`;
				}

				// ── Cloudflare admin ──

				const cloudflareApi = new CloudflareApi(env);
				checks["Cloudflare admin API"] = cloudflareApi.isConfigured()
					? "OK — credentials configured"
					: "DISABLED — CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are not both configured";

				const report = Object.entries(checks)
					.map(([k, v]) => `${k}: ${v}`)
					.join("\n");
				return toolText(`# Health Check\n\n${report}`);
			} catch (error) {
				return toolError(error);
			}
		},
	);
}

