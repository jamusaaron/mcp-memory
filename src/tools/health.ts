import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getMemoryIndex, listPeople } from "../utils/db";
import { listStaticFiles } from "../utils/r2";

export function registerHealthTools(server: McpServer, env: Env, userId: string) {
    server.tool(
        "health_check",
        "Check the health of all system components: D1, Vectorize, KV, R2, Workers AI.",
        {},
        async () => {
            try {
                const checks: Record<string, string> = {};

                try {
                    const index = await getMemoryIndex(userId, env);
                    checks["D1"] = `✓ ${index.total} memories (${index.embedded} embedded, ${index.pending_embedding} pending)`;
                    checks["Layer distribution"] = Object.entries(index.by_layer).map(([k, v]) => `${k}: ${v}`).join(", ");
                    checks["Category distribution"] = Object.entries(index.by_category).map(([k, v]) => `${k}: ${v}`).join(", ");
                } catch (e) {
                    checks["D1"] = `✗ ${String(e)}`;
                }

                try {
                    const people = await listPeople(userId, env);
                    checks["People"] = `✓ ${people.length} profiles tracked`;
                } catch (e) {
                    checks["People"] = `✗ ${String(e)}`;
                }

                try {
                    await env.VECTORIZE.query(new Array(1024).fill(0), { namespace: userId, topK: 1 });
                    checks["Vectorize"] = "✓ reachable";
                } catch (e) {
                    checks["Vectorize"] = `✗ ${String(e)}`;
                }

                try {
                    await env.KV.get("__health_check__");
                    checks["KV"] = "✓ reachable";
                } catch (e) {
                    checks["KV"] = `✗ ${String(e)}`;
                }

                try {
                    const files = await listStaticFiles(userId, env);
                    checks["R2"] = `✓ ${files.length} static files (${files.join(", ") || "none"})`;
                } catch (e) {
                    checks["R2"] = `✗ ${String(e)}`;
                }

                try {
                    const test = await env.AI.run("@cf/baai/bge-m3", { text: "health check" }) as any;
                    checks["Workers AI"] = test?.data?.[0] ? "✓ reachable" : "✗ unexpected response";
                } catch (e) {
                    checks["Workers AI"] = `✗ ${String(e)}`;
                }

                const report = Object.entries(checks).map(([k, v]) => `${k}: ${v}`).join("\n");
                return { content: [{ type: "text", text: `# Health Check\n\n${report}` }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Health check failed: " + String(error) }] };
            }
        }
    );
}
