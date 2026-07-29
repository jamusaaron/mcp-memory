import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker-provider.js";
import { RPCClientTransport, type McpAgent } from "agents/mcp";
import { readWorkspaceFromMcp, type McpWorkspaceSnapshot } from "./mcp-workspace";

export async function loadWorkspaceFromMcp(
	userId: string,
	env: Env,
): Promise<McpWorkspaceSnapshot> {
	const client = new Client(
		{ name: "MCP Memory Console", version: "1.0.0" },
		{ jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
	);
	const transport = new RPCClientTransport({
		namespace: env.MCP_OBJECT as unknown as DurableObjectNamespace<McpAgent>,
		name: `console:${userId}`,
		props: { userId },
	});
	await client.connect(transport);
	try {
		return await readWorkspaceFromMcp(client);
	} finally {
		await client.close();
	}
}
