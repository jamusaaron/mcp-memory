import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getMemoryIndex, listPeople } from "../utils/db";
import { listStaticFiles } from "../utils/r2";

export function registerHealthTools(server: McpServer, env: Env, userId: string) {
    server.tool(
        "health_check",
        "Run a comprehensive health check on all system components: D1 database, Vectorize index, KV cache, R2 storage, and Workers AI. Returns per-component status with counts and diagnostics. Use this to verify the system is operational or to diagnose connectivity issues.",
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
                    await env.KV.get("__health_check__");
                    checks["KV"] = "OK — reachable";
                } catch (e) {
                    checks["KV"] = `FAIL — ${String(e)}`;
                }

                try {
                    const files = await listStaticFiles(userId, env);
                    checks["R2"] = `OK — ${files.length} static files (${files.join(", ") || "none"})`;
                } catch (e) {
                    checks["R2"] = `FAIL — ${String(e)}`;
                }

                try {
                    const test = await env.AI.run("@cf/baai/bge-m3", { text: "health check" }) as any;
                    checks["Workers AI"] = test?.data?.[0] ? "OK — reachable" : "FAIL — unexpected response";
                } catch (e) {
                    checks["Workers AI"] = `FAIL — ${String(e)}`;
                }

                const report = Object.entries(checks).map(([k, v]) => `${k}: ${v}`).join("\n");
                return { content: [{ type: "text", text: `# Health Check\n\n${report}` }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Health check failed: " + String(error) }] };
            }
        }
    );
}
