import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { CloudflareApi } from "../utils/cloudflare-api";
import { toolError, toolText } from "../utils/tool-result";

const json = (value: unknown) => JSON.stringify(value, null, 2);

export function registerInfraTools(server: McpServer, env: Env) {
	const api = new CloudflareApi(env);
	const safe = (handler: (params: any) => Promise<string> | string) => async (params: any) => {
		try {
			return toolText(await handler(params));
		} catch (error) {
			return toolError(error);
		}
	};

	server.tool(
		"accounts_list",
		"List Cloudflare accounts. Requires CLOUDFLARE_API_TOKEN.",
		{},
		safe(async () => {
			const data = await api.requestJson<any>("/accounts");
			return json(
				data.result?.map((account: any) => ({ id: account.id, name: account.name })) ?? [],
			);
		}),
	);

	server.tool(
		"set_active_account",
		"Set the active Cloudflare account ID for this MCP session.",
		{
			account_id: z.string().min(1).describe("Account ID"),
		},
		safe(({ account_id }) => {
			api.setAccountId(account_id);
			return `Active account set to ${account_id} for this MCP session.`;
		}),
	);

	server.tool(
		"d1_database_create",
		"Create a new D1 database. Requires Cloudflare admin credentials.",
		{
			name: z.string().min(1),
		},
		safe(async ({ name }) => {
			const data = await api.requestJson<any>(
				`/accounts/${api.getAccountId()}/d1/database`,
				"POST",
				{ name },
			);
			return json(data.result);
		}),
	);

	server.tool(
		"d1_database_get",
		"Get details of a D1 database. Requires Cloudflare admin credentials.",
		{
			database_id: z.string().min(1),
		},
		safe(async ({ database_id }) => {
			const data = await api.requestJson<any>(
				`/accounts/${api.getAccountId()}/d1/database/${database_id}`,
			);
			return json(data.result);
		}),
	);

	server.tool(
		"d1_database_query",
		"Execute a SQL query against a D1 database. Requires Cloudflare admin credentials.",
		{
			database_id: z.string().min(1),
			sql: z.string().min(1),
			params: z.array(z.string()).optional(),
		},
		safe(async ({ database_id, sql, params }) => {
			const data = await api.requestJson<any>(
				`/accounts/${api.getAccountId()}/d1/database/${database_id}/query`,
				"POST",
				{ sql, params },
			);
			return json(data.result);
		}),
	);

	server.tool(
		"d1_database_delete",
		"Delete a D1 database. Requires Cloudflare admin credentials.",
		{
			database_id: z.string().min(1),
		},
		safe(async ({ database_id }) => {
			const data = await api.requestJson<any>(
				`/accounts/${api.getAccountId()}/d1/database/${database_id}`,
				"DELETE",
			);
			return json(data.result ?? data);
		}),
	);

	server.tool(
		"d1_databases_list",
		"List all D1 databases. Requires Cloudflare admin credentials.",
		{},
		safe(async () => {
			const data = await api.requestJson<any>(`/accounts/${api.getAccountId()}/d1/database`);
			return json(data.result ?? []);
		}),
	);

	server.tool(
		"memory_db_readonly_query",
		"Run a read-only query against the bound memory D1 database.",
		{
			sql: z.string().min(1).describe("A single SELECT or WITH query"),
		},
		safe(async ({ sql }) => {
			const normalized = sql.trim().replace(/;$/, "");
			if (!/^(SELECT|WITH)\b/i.test(normalized) || normalized.includes(";")) {
				throw new Error("Only one SELECT or WITH query is allowed");
			}
			const result = await env.DB.prepare(normalized).all();
			return json(result.results);
		}),
	);

	server.tool(
		"kv_namespace_create",
		"Create a KV namespace. Requires Cloudflare admin credentials.",
		{
			title: z.string().min(1),
		},
		safe(async ({ title }) => {
			const data = await api.requestJson<any>(
				`/accounts/${api.getAccountId()}/storage/kv/namespaces`,
				"POST",
				{ title },
			);
			return json(data.result);
		}),
	);

	server.tool(
		"kv_namespace_get",
		"Get a KV namespace. Requires Cloudflare admin credentials.",
		{
			namespace_id: z.string().min(1),
		},
		safe(async ({ namespace_id }) => {
			const data = await api.requestJson<any>(
				`/accounts/${api.getAccountId()}/storage/kv/namespaces/${namespace_id}`,
			);
			return json(data.result);
		}),
	);

	server.tool(
		"kv_namespace_update",
		"Rename a KV namespace. Requires Cloudflare admin credentials.",
		{
			namespace_id: z.string().min(1),
			title: z.string().min(1),
		},
		safe(async ({ namespace_id, title }) => {
			const data = await api.requestJson<any>(
				`/accounts/${api.getAccountId()}/storage/kv/namespaces/${namespace_id}`,
				"PUT",
				{ title },
			);
			return json(data.result ?? data);
		}),
	);

	server.tool(
		"kv_namespace_delete",
		"Delete a KV namespace. Requires Cloudflare admin credentials.",
		{
			namespace_id: z.string().min(1),
		},
		safe(async ({ namespace_id }) => {
			const data = await api.requestJson<any>(
				`/accounts/${api.getAccountId()}/storage/kv/namespaces/${namespace_id}`,
				"DELETE",
			);
			return json(data.result ?? data);
		}),
	);

	server.tool(
		"kv_namespaces_list",
		"List all KV namespaces. Requires Cloudflare admin credentials.",
		{},
		safe(async () => {
			const data = await api.requestJson<any>(
				`/accounts/${api.getAccountId()}/storage/kv/namespaces`,
			);
			return json(data.result ?? []);
		}),
	);

	server.tool(
		"hyperdrive_config_get",
		"Get a Hyperdrive config. Requires Cloudflare admin credentials.",
		{
			config_id: z.string().min(1),
		},
		safe(async ({ config_id }) => {
			const data = await api.requestJson<any>(
				`/accounts/${api.getAccountId()}/hyperdrive/configs/${config_id}`,
			);
			return json(data.result);
		}),
	);

	server.tool(
		"hyperdrive_config_edit",
		"Edit a Hyperdrive config. Requires Cloudflare admin credentials.",
		{
			config_id: z.string().min(1),
			updates: z.record(z.unknown()),
		},
		safe(async ({ config_id, updates }) => {
			const data = await api.requestJson<any>(
				`/accounts/${api.getAccountId()}/hyperdrive/configs/${config_id}`,
				"PATCH",
				updates,
			);
			return json(data.result);
		}),
	);

	server.tool(
		"hyperdrive_config_delete",
		"Delete a Hyperdrive config. Requires Cloudflare admin credentials.",
		{
			config_id: z.string().min(1),
		},
		safe(async ({ config_id }) => {
			const data = await api.requestJson<any>(
				`/accounts/${api.getAccountId()}/hyperdrive/configs/${config_id}`,
				"DELETE",
			);
			return json(data.result ?? data);
		}),
	);

	server.tool(
		"hyperdrive_configs_list",
		"List all Hyperdrive configs. Requires Cloudflare admin credentials.",
		{},
		safe(async () => {
			const data = await api.requestJson<any>(
				`/accounts/${api.getAccountId()}/hyperdrive/configs`,
			);
			return json(data.result ?? []);
		}),
	);

	server.tool(
		"workers_get_worker",
		"Get a Worker's settings metadata. Requires Cloudflare admin credentials.",
		{
			script_name: z.string().min(1),
		},
		safe(async ({ script_name }) => {
			const data = await api.requestJson<any>(
				`/accounts/${api.getAccountId()}/workers/scripts/${script_name}/settings`,
			);
			return json(data.result);
		}),
	);

	server.tool(
		"workers_get_worker_code",
		"Get a Worker's source code. Requires Cloudflare admin credentials.",
		{
			script_name: z.string().min(1),
		},
		safe(async ({ script_name }) => {
			const code = await api.requestText(
				`/accounts/${api.getAccountId()}/workers/scripts/${script_name}/content`,
			);
			return code.slice(0, 5000);
		}),
	);

	server.tool(
		"workers_list",
		"List all Workers. Requires Cloudflare admin credentials.",
		{},
		safe(async () => {
			const data = await api.requestJson<any>(
				`/accounts/${api.getAccountId()}/workers/scripts`,
			);
			return json(
				data.result?.map((worker: any) => ({
					id: worker.id,
					name: worker.name ?? worker.id,
					modified: worker.modified_on,
				})) ?? [],
			);
		}),
	);

	server.tool(
		"search_cloudflare_documentation",
		"Build a Cloudflare developer-documentation search URL.",
		{
			query: z.string().min(1),
		},
		safe(
			({ query }) =>
				`Search Cloudflare docs for: "${query}"\nhttps://developers.cloudflare.com/?q=${encodeURIComponent(
					query,
				)}`,
		),
	);

	server.tool(
		"migrate_pages_to_workers_guide",
		"Get the Cloudflare Pages-to-Workers migration guide.",
		{},
		safe(
			() =>
				"Migration guide: https://developers.cloudflare.com/pages/migration-guides/migrate-from-pages-to-workers/\n\n" +
				"Key steps:\n1. Move static assets to Workers static assets\n2. Convert _worker.js to ES module format\n" +
				"3. Update wrangler.jsonc configuration\n4. Update build commands",
		),
	);
}
