import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const CF_API = "https://api.cloudflare.com/client/v4";

async function cfFetch(path: string, env: Env, method: string = "GET", body?: unknown): Promise<any> {
    const token = (env as any).CLOUDFLARE_API_TOKEN;
    if (!token) throw new Error("CLOUDFLARE_API_TOKEN not configured");

    const res = await fetch(`${CF_API}${path}`, {
        method,
        headers: {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    return res.json();
}

function getAccountId(env: Env): string {
    const id = (env as any).CLOUDFLARE_ACCOUNT_ID;
    if (!id) throw new Error("CLOUDFLARE_ACCOUNT_ID not configured");
    return id;
}

function wrapHandler(fn: () => Promise<string>): () => Promise<{ content: Array<{ type: "text"; text: string }> }> {
    return async () => {
        try {
            const text = await fn();
            return { content: [{ type: "text" as const, text }] };
        } catch (error) {
            return { content: [{ type: "text" as const, text: "Error: " + String(error) }] };
        }
    };
}

export function registerInfraTools(server: McpServer, env: Env) {
    // ── Accounts ──
    server.tool("accounts_list", "List Cloudflare accounts.", {},
        wrapHandler(async () => {
            const data = await cfFetch("/accounts", env);
            return JSON.stringify(data.result?.map((a: any) => ({ id: a.id, name: a.name })) ?? [], null, 2);
        })
    );

    server.tool("set_active_account", "Set the active Cloudflare account ID for this session.", {
        account_id: z.string().describe("Account ID"),
    }, async ({ account_id }) => {
        try {
            return { content: [{ type: "text", text: `Active account set to ${account_id}. Note: this is informational only — use CLOUDFLARE_ACCOUNT_ID env var for persistence.` }] };
        } catch (error) {
            return { content: [{ type: "text", text: "Error: " + String(error) }] };
        }
    });

    // ── D1 ──
    server.tool("d1_database_create", "Create a new D1 database.", {
        name: z.string().describe("Database name"),
    }, async ({ name }) => {
        try {
            const accountId = getAccountId(env);
            const data = await cfFetch(`/accounts/${accountId}/d1/database`, env, "POST", { name });
            return { content: [{ type: "text", text: JSON.stringify(data.result, null, 2) }] };
        } catch (error) {
            return { content: [{ type: "text", text: "Error: " + String(error) }] };
        }
    });

    server.tool("d1_database_get", "Get details of a D1 database.", {
        database_id: z.string(),
    }, async ({ database_id }) => {
        try {
            const accountId = getAccountId(env);
            const data = await cfFetch(`/accounts/${accountId}/d1/database/${database_id}`, env);
            return { content: [{ type: "text", text: JSON.stringify(data.result, null, 2) }] };
        } catch (error) {
            return { content: [{ type: "text", text: "Error: " + String(error) }] };
        }
    });

    server.tool("d1_database_query", "Execute a SQL query against a D1 database.", {
        database_id: z.string(),
        sql: z.string().describe("SQL query"),
        params: z.array(z.string()).optional(),
    }, async ({ database_id, sql, params }) => {
        try {
            const accountId = getAccountId(env);
            const data = await cfFetch(`/accounts/${accountId}/d1/database/${database_id}/query`, env, "POST", { sql, params });
            return { content: [{ type: "text", text: JSON.stringify(data.result, null, 2) }] };
        } catch (error) {
            return { content: [{ type: "text", text: "Error: " + String(error) }] };
        }
    });

    server.tool("d1_database_delete", "Delete a D1 database.", {
        database_id: z.string(),
    }, async ({ database_id }) => {
        try {
            const accountId = getAccountId(env);
            const data = await cfFetch(`/accounts/${accountId}/d1/database/${database_id}`, env, "DELETE");
            return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        } catch (error) {
            return { content: [{ type: "text", text: "Error: " + String(error) }] };
        }
    });

    server.tool("d1_databases_list", "List all D1 databases.", {},
        wrapHandler(async () => {
            const accountId = getAccountId(env);
            const data = await cfFetch(`/accounts/${accountId}/d1/database`, env);
            return JSON.stringify(data.result, null, 2);
        })
    );

    server.tool("memory_db_readonly_query", "Run a read-only query against the memory D1 database directly via binding.", {
        sql: z.string().describe("SQL query (SELECT only)"),
    }, async ({ sql }) => {
        try {
            if (!sql.trim().toUpperCase().startsWith("SELECT")) {
                return { content: [{ type: "text", text: "Only SELECT queries allowed via this tool." }] };
            }
            const result = await env.DB.prepare(sql).all();
            return { content: [{ type: "text", text: JSON.stringify(result.results, null, 2) }] };
        } catch (error) {
            return { content: [{ type: "text", text: "Error: " + String(error) }] };
        }
    });

    // ── KV ──
    server.tool("kv_namespace_create", "Create a KV namespace.", {
        title: z.string(),
    }, async ({ title }) => {
        try {
            const accountId = getAccountId(env);
            const data = await cfFetch(`/accounts/${accountId}/storage/kv/namespaces`, env, "POST", { title });
            return { content: [{ type: "text", text: JSON.stringify(data.result, null, 2) }] };
        } catch (error) {
            return { content: [{ type: "text", text: "Error: " + String(error) }] };
        }
    });

    server.tool("kv_namespace_get", "Get a KV namespace.", {
        namespace_id: z.string(),
    }, async ({ namespace_id }) => {
        try {
            const accountId = getAccountId(env);
            const data = await cfFetch(`/accounts/${accountId}/storage/kv/namespaces/${namespace_id}`, env);
            return { content: [{ type: "text", text: JSON.stringify(data.result, null, 2) }] };
        } catch (error) {
            return { content: [{ type: "text", text: "Error: " + String(error) }] };
        }
    });

    server.tool("kv_namespace_update", "Rename a KV namespace.", {
        namespace_id: z.string(),
        title: z.string(),
    }, async ({ namespace_id, title }) => {
        try {
            const accountId = getAccountId(env);
            const data = await cfFetch(`/accounts/${accountId}/storage/kv/namespaces/${namespace_id}`, env, "PUT", { title });
            return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        } catch (error) {
            return { content: [{ type: "text", text: "Error: " + String(error) }] };
        }
    });

    server.tool("kv_namespace_delete", "Delete a KV namespace.", {
        namespace_id: z.string(),
    }, async ({ namespace_id }) => {
        try {
            const accountId = getAccountId(env);
            const data = await cfFetch(`/accounts/${accountId}/storage/kv/namespaces/${namespace_id}`, env, "DELETE");
            return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        } catch (error) {
            return { content: [{ type: "text", text: "Error: " + String(error) }] };
        }
    });

    server.tool("kv_namespaces_list", "List all KV namespaces.", {},
        wrapHandler(async () => {
            const accountId = getAccountId(env);
            const data = await cfFetch(`/accounts/${accountId}/storage/kv/namespaces`, env);
            return JSON.stringify(data.result, null, 2);
        })
    );

    // ── Hyperdrive ──
    server.tool("hyperdrive_config_get", "Get a Hyperdrive config.", {
        config_id: z.string(),
    }, async ({ config_id }) => {
        try {
            const accountId = getAccountId(env);
            const data = await cfFetch(`/accounts/${accountId}/hyperdrive/configs/${config_id}`, env);
            return { content: [{ type: "text", text: JSON.stringify(data.result, null, 2) }] };
        } catch (error) {
            return { content: [{ type: "text", text: "Error: " + String(error) }] };
        }
    });

    server.tool("hyperdrive_config_edit", "Edit a Hyperdrive config.", {
        config_id: z.string(),
        updates: z.record(z.unknown()).describe("Config updates"),
    }, async ({ config_id, updates }) => {
        try {
            const accountId = getAccountId(env);
            const data = await cfFetch(`/accounts/${accountId}/hyperdrive/configs/${config_id}`, env, "PATCH", updates);
            return { content: [{ type: "text", text: JSON.stringify(data.result, null, 2) }] };
        } catch (error) {
            return { content: [{ type: "text", text: "Error: " + String(error) }] };
        }
    });

    server.tool("hyperdrive_config_delete", "Delete a Hyperdrive config.", {
        config_id: z.string(),
    }, async ({ config_id }) => {
        try {
            const accountId = getAccountId(env);
            const data = await cfFetch(`/accounts/${accountId}/hyperdrive/configs/${config_id}`, env, "DELETE");
            return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        } catch (error) {
            return { content: [{ type: "text", text: "Error: " + String(error) }] };
        }
    });

    server.tool("hyperdrive_configs_list", "List all Hyperdrive configs.", {},
        wrapHandler(async () => {
            const accountId = getAccountId(env);
            const data = await cfFetch(`/accounts/${accountId}/hyperdrive/configs`, env);
            return JSON.stringify(data.result, null, 2);
        })
    );

    // ── Workers ──
    server.tool("workers_get_worker", "Get a Worker's metadata.", {
        script_name: z.string(),
    }, async ({ script_name }) => {
        try {
            const accountId = getAccountId(env);
            const data = await cfFetch(`/accounts/${accountId}/workers/scripts/${script_name}`, env);
            return { content: [{ type: "text", text: JSON.stringify(data.result, null, 2) }] };
        } catch (error) {
            return { content: [{ type: "text", text: "Error: " + String(error) }] };
        }
    });

    server.tool("workers_get_worker_code", "Get a Worker's source code.", {
        script_name: z.string(),
    }, async ({ script_name }) => {
        try {
            const accountId = getAccountId(env);
            const token = (env as any).CLOUDFLARE_API_TOKEN;
            if (!token) throw new Error("CLOUDFLARE_API_TOKEN not configured");
            const res = await fetch(`${CF_API}/accounts/${accountId}/workers/scripts/${script_name}/content`, {
                headers: { "Authorization": `Bearer ${token}` },
            });
            const code = await res.text();
            return { content: [{ type: "text", text: code.slice(0, 5000) }] };
        } catch (error) {
            return { content: [{ type: "text", text: "Error: " + String(error) }] };
        }
    });

    server.tool("workers_list", "List all Workers.", {},
        wrapHandler(async () => {
            const accountId = getAccountId(env);
            const data = await cfFetch(`/accounts/${accountId}/workers/scripts`, env);
            return JSON.stringify(data.result?.map((w: any) => ({ id: w.id, name: w.name ?? w.id, modified: w.modified_on })) ?? [], null, 2);
        })
    );

    server.tool("search_cloudflare_documentation", "Search Cloudflare developer documentation.", {
        query: z.string().describe("Search query"),
    }, async ({ query }) => {
        try {
            return { content: [{ type: "text", text: `Search Cloudflare docs for: "${query}"\nVisit: https://developers.cloudflare.com/?q=${encodeURIComponent(query)}` }] };
        } catch (error) {
            return { content: [{ type: "text", text: "Error: " + String(error) }] };
        }
    });

    server.tool("migrate_pages_to_workers_guide", "Get the migration guide from Cloudflare Pages to Workers.", {},
        wrapHandler(async () => {
            return "Migration guide: https://developers.cloudflare.com/pages/migration-guides/migrate-from-pages-to-workers/\n\nKey steps:\n1. Move static assets to Workers static assets\n2. Convert _worker.js to ES module format\n3. Update wrangler.jsonc configuration\n4. Update build commands";
        })
    );
}
