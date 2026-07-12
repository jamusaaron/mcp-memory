import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { promptBuild, promptImprove, promptEvaluate } from "../utils/prompt-engineering";

export function registerPromptEngineeringTools(server: McpServer, env: any, userId: string) {
    server.tool(
        "prompt_build",
        "Produces a paste-ready prompt for a target tool and returns configuration and assumption notes.",
        {
            target_tool: z.string().describe("The name of the target tool"),
            description: z.string().describe("Description of what the prompt should do"),
            use_memory: z.boolean().optional().default(false).describe("Whether to inject retrieved memory"),
            target_capability: z.string().optional().describe("Optional target capability or model routing")
        },
        async ({ target_tool, description, use_memory, target_capability }) => {
            try {
                const result = await promptBuild({ target_tool, description, use_memory, target_capability, userId, env });
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify(result, null, 2)
                    }]
                };
            } catch (error) {
                return {
                    isError: true,
                    content: [{ type: "text", text: String(error) }]
                };
            }
        }
    );

    server.tool(
        "prompt_improve",
        "Identifies failure risks in an existing prompt and returns an improved prompt preserving original objectives and constraints.",
        {
            prompt: z.string().describe("The existing prompt to improve"),
            target_capability: z.string().optional().describe("Optional target capability or model routing")
        },
        async ({ prompt, target_capability }) => {
            try {
                const result = await promptImprove({ prompt, target_capability, userId, env });
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify(result, null, 2)
                    }]
                };
            } catch (error) {
                return {
                    isError: true,
                    content: [{ type: "text", text: String(error) }]
                };
            }
        }
    );

    server.tool(
        "prompt_evaluate",
        "Evaluates a prompt across clarity, grounding, scope, output contract, target-tool fit, token efficiency, and operational safety without mutating memory.",
        {
            prompt: z.string().describe("The prompt to evaluate")
        },
        async ({ prompt }) => {
            try {
                const result = await promptEvaluate({ prompt, userId, env });
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify(result, null, 2)
                    }]
                };
            } catch (error) {
                return {
                    isError: true,
                    content: [{ type: "text", text: String(error) }]
                };
            }
        }
    );
}
