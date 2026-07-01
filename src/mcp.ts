import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { version } from "../package.json";

import { registerMemoryTools } from "./tools/memory";
import { registerPeopleTools } from "./tools/people";
import { registerUncertaintyTools } from "./tools/uncertainty";
import { registerSessionTools } from "./tools/session";
import { registerStaticFileTools } from "./tools/static-files";
import { registerBehavioralTools } from "./tools/behavioral";
import { registerIngestionTools } from "./tools/ingestion";
import { registerAiAgentTools } from "./tools/ai-agents";
import { registerHealthTools } from "./tools/health";
import { registerInfraTools } from "./tools/infra";

type MyMCPProps = {
    userId: string;
};

export class MyMCP extends McpAgent<Env, {}, MyMCPProps> {
    server = new McpServer({
        name: "MCP Memory",
        version,
    });

    async init() {
        const env = this.env as Env;
        const userId = this.props.userId;

        registerMemoryTools(this.server, env, userId);
        registerPeopleTools(this.server, env, userId);
        registerUncertaintyTools(this.server, env, userId);
        registerSessionTools(this.server, env, userId);
        registerStaticFileTools(this.server, env, userId);
        registerBehavioralTools(this.server, env, userId);
        registerIngestionTools(this.server, env, userId);
        registerAiAgentTools(this.server, env, userId);
        registerHealthTools(this.server, env, userId);
        registerInfraTools(this.server, env);
    }
}
