import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CloudflareApi } from "../utils/cloudflare-api";
import { getMemoryIndex, listPeople } from "../utils/db";
import { listStaticFiles } from "../utils/static-context";
import { toolError, toolText } from "../utils/tool-result";

export function registerHealthTools(server: McpServer, env: Env, userId: string) {
	server.tool(
		"health_check",
		"Run a comprehensive health check on all system components: D1 database, Vectorize index, KV cache, persistent context, and Workers AI. Returns per-component status with counts and diagnostics. Use this to verify the system is operational or to diagnose connectivity issues.",
		{},
		async () => {
			try {
				const checks: Record<string, string> = {};

				try {
					const index = await getMemoryIndex(userId, env);
					checks["D1"] =
						`OK — ${index.total} memories (${index.embedded} embedded, ${index.pending_embedding} pending)`;
					checks["Layer distribution"] = Object.entries(index.by_layer)
						.map(([k, v]) => `${k}: ${v}`)
						.join(", ");
					checks["Category distribution"] = Object.entries(index.by_category)
						.map(([k, v]) => `${k}: ${v}`)
						.join(", ");
				} catch (e) {
					checks["D1"] = `FAIL — ${String(e)}`;
				}

				try {
					const people = await listPeople(userId, env);
					checks["People"] = `OK — ${people.length} profiles tracked`;
				} catch (e) {
					checks["People"] = `FAIL — ${String(e)}`;
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
