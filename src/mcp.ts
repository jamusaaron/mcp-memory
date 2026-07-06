import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { version } from "../package.json";

import { registerAiAgentTools } from "./tools/ai-agents";
import { registerBehavioralTools } from "./tools/behavioral";
import { registerHealthTools } from "./tools/health";
import { registerInfraTools } from "./tools/infra";
import { registerIngestionTools } from "./tools/ingestion";
import { registerMemoryTools } from "./tools/memory";
import { registerPeopleTools } from "./tools/people";
import { registerSessionTools } from "./tools/session";
import { registerUncertaintyTools } from "./tools/uncertainty";

type MyMCPProps = {
	userId: string;
};

export class MyMCP extends McpAgent<Env, Record<string, never>, MyMCPProps> {
	server = new McpServer({
		name: "MCP Memory",
		version,
	});

	async init() {
		const env = this.env as Env;
		const userId = this.props?.userId;
		if (!userId) {
			throw new Error("MCP session is missing its user ID");
		}

		registerMemoryTools(this.server, env, userId);
		registerPeopleTools(this.server, env, userId);
		registerUncertaintyTools(this.server, env, userId);
		registerSessionTools(this.server, env, userId);
		registerBehavioralTools(this.server, env, userId);
		registerIngestionTools(this.server, env, userId);
		registerAiAgentTools(this.server, env, userId);
		registerHealthTools(this.server, env, userId);
		registerInfraTools(this.server, env);
	}
}
