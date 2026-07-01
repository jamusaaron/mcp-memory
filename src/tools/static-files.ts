import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readStaticFile, writeStaticFile, listStaticFiles } from "../utils/r2";

export function registerStaticFileTools(server: McpServer, env: Env, userId: string) {
    server.tool(
        "read_static_file",
        "Read a static context file from R2 storage. These are markdown documents the system treats like a filesystem (context files, protocol docs, personality docs).",
        { filename: z.string().describe("Filename to read (e.g., context_core, interaction_rules, ai_personality)") },
        async ({ filename }) => {
            try {
                const content = await readStaticFile(userId, filename, env);
                if (!content) {
                    const files = await listStaticFiles(userId, env);
                    const available = files.length > 0 ? `\nAvailable files: ${files.join(", ")}` : "";
                    return { content: [{ type: "text", text: `File '${filename}' not found.${available}` }] };
                }
                return { content: [{ type: "text", text: content }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to read file: " + String(error) }] };
            }
        }
    );

    server.tool(
        "update_static_file",
        "Create or update a static context file in R2 storage.",
        {
            filename: z.string().describe("Filename to write"),
            content: z.string().describe("File content (markdown)"),
        },
        async ({ filename, content }) => {
            try {
                await writeStaticFile(userId, filename, content, env);
                return { content: [{ type: "text", text: `File '${filename}' updated.` }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to update file: " + String(error) }] };
            }
        }
    );
}
