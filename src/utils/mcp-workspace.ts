import { z } from "zod";

export const consoleMemorySchema = z.object({
	id: z.string(),
	content: z.string(),
	category: z.string(),
	layer: z.string(),
	confidence: z.number(),
	salience: z.number(),
	pinned: z.boolean(),
	tags: z.array(z.string()),
	created_at: z.string(),
});

export const consoleMemoryListSchema = z.object({
	memories: z.array(consoleMemorySchema),
});

export const memoryIndexSchema = z.object({
	total: z.number(),
	by_category: z.record(z.string(), z.number()),
	by_layer: z.record(z.string(), z.number()),
	embedded: z.number(),
	pending_embedding: z.number(),
	suppressed: z.number(),
});

export type McpWorkspaceClient = {
	callTool(request: {
		name: string;
		arguments: Record<string, unknown>;
	}): Promise<unknown>;
};

export type McpWorkspaceSnapshot = {
	memories: z.infer<typeof consoleMemorySchema>[];
	index: z.infer<typeof memoryIndexSchema>;
};

function structuredResult(result: unknown): unknown {
	const parsed = z
		.object({
			isError: z.boolean().optional(),
			structuredContent: z.unknown().optional(),
		})
		.passthrough()
		.safeParse(result);
	if (!parsed.success || parsed.data.isError || parsed.data.structuredContent === undefined) {
		throw new Error("MCP tool returned no structured workspace data");
	}
	return parsed.data.structuredContent;
}

export async function readWorkspaceFromMcp(
	client: McpWorkspaceClient,
): Promise<McpWorkspaceSnapshot> {
	try {
		const memoriesResult = await client.callTool({
			name: "list_memories",
			arguments: { limit: 100, offset: 0 },
		});
		const indexResult = await client.callTool({
			name: "get_memory_index",
			arguments: {},
		});
		return {
			memories: consoleMemoryListSchema.parse(structuredResult(memoriesResult)).memories,
			index: memoryIndexSchema.parse(structuredResult(indexResult)),
		};
	} catch {
		throw new Error("Unable to read MCP workspace");
	}
}
