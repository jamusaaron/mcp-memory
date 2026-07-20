import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getMemoryIndex, listPeople } from "../utils/db";
import { listStaticFiles, r2Backend } from "../utils/r2";
import { getKV, kvBackend } from "../utils/kv";
import { checkTextGeneration } from "../utils/ai";

export function registerHealthTools(server: McpServer, env: Env, userId: string) {
    server.tool(
        "health_check",
        "Run a comprehensive health check on all system components: D1 database, Vectorize index, cache (KV or D1 fallback), static files (R2 or D1 fallback), and Workers AI (both embeddings AND text generation — the latter is what the living summary, profiles, triage and behavioral model depend on). Returns per-component status with counts and diagnostics, including which text-generation model is currently live. Use this to verify the system is operational or to diagnose connectivity issues.",
        {},
        async () => {
            try {
                const checks: Record<string, string> = {};

                try {
                    const index = await getMemoryIndex(userId, env);
                    checks["D1"] = `OK — ${index.total} memories (${index.embedded} embedded, ${index.pending_embedding} pending)`;
                    checks["Layer distribution"] = Object.entries(index.by_layer).map(([k, v]) => `${k}: ${v}`).join(", ");
                    checks["Category distribution"] = Object.entries(index.by_category).map(([k, v]) => `${k}: ${v}`).join(", ");
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
                    await env.VECTORIZE.query(new Array(1024).fill(0), { namespace: userId, topK: 1 });
                    checks["Vectorize"] = "OK — reachable";
                } catch (e) {
                    checks["Vectorize"] = `FAIL — ${String(e)}`;
                }

                try {
                    await getKV("__health_check__", env);
                    checks["Cache"] = `OK — backed by ${kvBackend(env) === "kv" ? "KV" : "D1 (kv_store fallback)"}`;
                } catch (e) {
                    checks["Cache"] = `FAIL — ${String(e)}`;
                }

                try {
                    const files = await listStaticFiles(userId, env);
                    checks["Static files"] = `OK — backed by ${r2Backend(env) === "r2" ? "R2" : "D1 (static_files fallback)"}, ${files.length} files (${files.join(", ") || "none"})`;
                } catch (e) {
                    checks["Static files"] = `FAIL — ${String(e)}`;
                }

                try {
                    const test = await env.AI.run("@cf/baai/bge-m3", { text: "health check" }) as any;
                    checks["Workers AI (embeddings)"] = test?.data?.[0] ? "OK — reachable" : "FAIL — unexpected response";
                } catch (e) {
                    checks["Workers AI (embeddings)"] = `FAIL — ${String(e)}`;
                }

                try {
                    const model = await checkTextGeneration(env);
                    checks["Workers AI (text generation)"] = `OK — live model: ${model}`;
                } catch (e) {
                    checks["Workers AI (text generation)"] = `FAIL — ${String(e)} (living summary, profiles, triage & behavioral model depend on this)`;
                }

                const report = Object.entries(checks).map(([k, v]) => `${k}: ${v}`).join("\n");
                return { content: [{ type: "text", text: `# Health Check\n\n${report}` }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Health check failed: " + String(error) }] };
            }
        }
    );
}
