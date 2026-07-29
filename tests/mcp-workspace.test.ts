import assert from "node:assert/strict";
import test from "node:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createApp } from "../src/app";
import { registerMemoryTools } from "../src/tools/memory";
import { createSqliteD1Harness, initializeSqliteD1 } from "./helpers/sqlite-d1";

type ToolResult = {
	isError?: boolean;
	structuredContent?: unknown;
};

type McpWorkspaceClient = {
	callTool(request: { name: string; arguments: Record<string, unknown> }): Promise<ToolResult>;
};

type McpWorkspaceModule = {
	readWorkspaceFromMcp?: (client: McpWorkspaceClient) => Promise<unknown>;
};

test("loads console records and the index through the MCP memory tools", async () => {
	const module = (await import("../src/utils/mcp-workspace").catch(() => undefined)) as
		| McpWorkspaceModule
		| undefined;
	const readWorkspaceFromMcp = module?.readWorkspaceFromMcp;
	assert.equal(typeof readWorkspaceFromMcp, "function", "the console needs an MCP read bridge");
	if (typeof readWorkspaceFromMcp !== "function") return;

	const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
	const snapshot = await readWorkspaceFromMcp({
		async callTool(request) {
			calls.push(request);
			if (request.name === "list_memories") {
				return {
					structuredContent: {
						memories: [
							{
								id: "memory-1",
								content: "Read via MCP",
								category: "knowledge",
								layer: "current",
								confidence: 0.8,
								salience: 0.5,
								pinned: false,
								tags: ["mcp"],
								created_at: "2026-07-30T00:00:00.000Z",
							},
						],
					},
				};
			}
			return {
				structuredContent: {
					total: 1,
					by_category: { knowledge: 1 },
					by_layer: { current: 1 },
					embedded: 1,
					pending_embedding: 0,
					suppressed: 0,
				},
			};
		},
	});

	assert.deepEqual(calls, [
		{ name: "list_memories", arguments: { limit: 100, offset: 0 } },
		{ name: "get_memory_index", arguments: {} },
	]);
	assert.deepEqual(snapshot, {
		memories: [
			{
				id: "memory-1",
				content: "Read via MCP",
				category: "knowledge",
				layer: "current",
				confidence: 0.8,
				salience: 0.5,
				pinned: false,
				tags: ["mcp"],
				created_at: "2026-07-30T00:00:00.000Z",
			},
		],
		index: {
			total: 1,
			by_category: { knowledge: 1 },
			by_layer: { current: 1 },
			embedded: 1,
			pending_embedding: 0,
			suppressed: 0,
		},
	});
});

test("rejects MCP read failures instead of rendering a partial workspace", async () => {
	const module = (await import("../src/utils/mcp-workspace").catch(() => undefined)) as
		| McpWorkspaceModule
		| undefined;
	const readWorkspaceFromMcp = module?.readWorkspaceFromMcp;
	assert.equal(typeof readWorkspaceFromMcp, "function", "the console needs an MCP read bridge");
	if (typeof readWorkspaceFromMcp !== "function") return;

	await assert.rejects(
		() =>
			readWorkspaceFromMcp({
				async callTool() {
					return { isError: true };
				},
			}),
		/Unable to read MCP workspace/,
	);
});

test("MCP browse tools emit typed console records and index data", async () => {
	type Registration = {
		config: { outputSchema: { parse(value: unknown): unknown } };
		handler: (input: any) => Promise<{ structuredContent?: unknown }>;
	};
	const registrations = new Map<string, Registration>();
	const server = {
		tool() {
			return undefined;
		},
		registerTool(name: string, config: Registration["config"], handler: Registration["handler"]) {
			registrations.set(name, { config, handler });
		},
	} as unknown as McpServer;
	const memoryRow = {
		id: "memory-1",
		userId: "tenant-a",
		text: "Read through the MCP tool",
		category: "knowledge",
		layer: "current",
		tags: '["mcp"]',
		triggers: "[]",
		linked_people: "[]",
		confidence: 0.8,
		salience: 0.5,
		emotion_weight: 0,
		source_type: "stated",
		embedding_status: "embedded",
		suppressed: 0,
		suppression_reason: null,
		pinned: 0,
		access_count: 0,
		last_accessed: null,
		last_verified: null,
		created_at: "2026-07-30T00:00:00.000Z",
		updated_at: "2026-07-30T00:00:00.000Z",
	};
	const env = {
		DB: {
			prepare(sql: string) {
				return {
					bind() {
						return {
							all: async () => {
								if (sql.includes("SELECT * FROM memories")) {
									return { results: [memoryRow] };
								}
								if (sql.includes("GROUP BY category")) {
									return { results: [{ category: "knowledge", cnt: 1 }] };
								}
								return { results: [{ layer: "current", cnt: 1 }] };
							},
							first: async () => ({
								total: 1,
								embedded: 1,
								pending: 0,
								suppressed: 0,
							}),
						};
					},
				};
			},
		},
	} as unknown as Env;

	registerMemoryTools(server, env, "tenant-a");
	const list = registrations.get("list_memories");
	const index = registrations.get("get_memory_index");
	assert.ok(list, "list_memories must provide a typed output schema");
	assert.ok(index, "get_memory_index must provide a typed output schema");
	if (!list || !index) return;

	const listResult = await list.handler({ limit: 100, offset: 0 });
	const indexResult = await index.handler({});
	assert.deepEqual(listResult.structuredContent, {
		memories: [
			{
				id: "memory-1",
				content: "Read through the MCP tool",
				category: "knowledge",
				layer: "current",
				confidence: 0.8,
				salience: 0.5,
				pinned: false,
				tags: ["mcp"],
				created_at: "2026-07-30T00:00:00.000Z",
			},
		],
	});
	assert.deepEqual(indexResult.structuredContent, {
		total: 1,
		by_category: { knowledge: 1 },
		by_layer: { current: 1 },
		embedded: 1,
		pending_embedding: 0,
		suppressed: 0,
	});
	list.config.outputSchema.parse(listResult.structuredContent);
	index.config.outputSchema.parse(indexResult.structuredContent);
});

test("serves a selected console workspace through the MCP bridge", async (t) => {
	const harness = createSqliteD1Harness();
	t.after(() => harness.close());
	Object.assign(harness.env, {
		APP_ACCESS_KEY: "private-access-key",
		COOKIE_ENCRYPTION_KEY: "cookie-signing-key",
		RATE_LIMITER: { limit: async () => ({ success: true }) },
	});
	await initializeSqliteD1(harness.env);
	const tenants: string[] = [];
	const app = createApp(
		async () => new Response("unexpected MCP transport", { status: 404 }),
		{
			loadWorkspaceFromMcp: async (tenantId) => {
				tenants.push(tenantId);
				return {
					memories: [],
					index: {
						total: 0,
						by_category: {},
						by_layer: {},
						embedded: 0,
						pending_embedding: 0,
						suppressed: 0,
					},
				};
			},
		},
	);

	const response = await app.fetch(
		new Request("https://example.test/tenant-a/workspace", {
			headers: { Accept: "application/json", Authorization: "Bearer private-access-key" },
		}),
		harness.env,
		{} as ExecutionContext,
	);

	assert.equal(response.status, 200);
	assert.deepEqual(tenants, ["tenant-a"]);
	assert.deepEqual(await response.json(), {
		success: true,
		memories: [],
		index: {
			total: 0,
			by_category: {},
			by_layer: {},
			embedded: 0,
			pending_embedding: 0,
			suppressed: 0,
		},
	});
});
