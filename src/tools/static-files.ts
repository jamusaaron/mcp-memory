import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readStaticFile, writeStaticFile, listStaticFiles, deleteStaticFile } from "../utils/r2";

export function registerStaticFileTools(server: McpServer, env: Env, userId: string) {
    server.tool(
        "read_static_file",
        "Read a static context file from R2 storage. These are persistent markdown documents that act as the system's filesystem — context files, protocol docs, personality configs, the self-profile, mood tracker, etc. If the file doesn't exist, lists available files.",
        { filename: z.string().describe("Filename to read (e.g., 'context_core', 'interaction_rules', 'ai_personality', 'self_profile', 'context_current')") },
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
        "Create or overwrite a static context file in R2 storage. Use this to store persistent documents like interaction rules, context docs, personality configs, or any reference material that should persist across sessions.",
        {
            filename: z.string().describe("Filename to create/update"),
            content: z.string().describe("File content (typically markdown)"),
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

    server.tool(
        "delete_static_file",
        "Delete a static context file from R2 storage. Use this to remove outdated or no-longer-needed documents.",
        {
            filename: z.string().describe("Filename to delete"),
        },
        async ({ filename }) => {
            try {
                await deleteStaticFile(userId, filename, env);
                return { content: [{ type: "text", text: `File '${filename}' deleted.` }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to delete file: " + String(error) }] };
            }
        }
    );

    server.tool(
        "list_static_files",
        "List all static context files stored in R2. Shows filenames of all persistent documents available for this user.",
        {},
        async () => {
            try {
                const files = await listStaticFiles(userId, env);
                if (files.length === 0) {
                    return { content: [{ type: "text", text: "No static files stored." }] };
                }
                return { content: [{ type: "text", text: `${files.length} static files:\n${files.map(f => `- ${f}`).join("\n")}` }] };
            } catch (error) {
                return { content: [{ type: "text", text: "Failed to list files: " + String(error) }] };
            }
        }
    );
}
