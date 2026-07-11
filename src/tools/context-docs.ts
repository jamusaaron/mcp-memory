import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	deleteStaticFile,
	listStaticFiles,
	readStaticFile,
	writeStaticFile,
} from "../utils/static-context";
import { toolError, toolText } from "../utils/tool-result";

/**
 * KV-backed persistent context documents (replaces object-storage static files).
 * Tool names avoid the retired storage-era names so the surface contract holds.
 */
export function registerContextDocTools(server: McpServer, env: Env, userId: string) {
	server.tool(
		"read_context_doc",
		"Read a persistent context document (stored in KV). Common names: context_current, context_core, interaction_rules, ai_personality, self_profile, mood_tracker, personality_styles.",
		{
			filename: z
				.string()
				.describe("Document name, e.g. context_current or self_profile"),
		},
		async ({ filename }) => {
			try {
				const content = await readStaticFile(userId, filename, env);
				if (!content) {
					const files = await listStaticFiles(userId, env);
					const available =
						files.length > 0 ? `\nAvailable: ${files.join(", ")}` : "\nNo documents yet.";
					return toolText(`Document '${filename}' not found.${available}`);
				}
				return toolText(content);
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.tool(
		"write_context_doc",
		"Create or overwrite a persistent context document in KV. Use for standing notes that should load across sessions.",
		{
			filename: z.string().describe("Document name"),
			content: z.string().describe("Document content (markdown recommended)"),
		},
		async ({ filename, content }) => {
			try {
				const safe = filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
				await writeStaticFile(userId, safe, content, env);
				return toolText(`Document '${safe}' saved (${content.length} chars).`);
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.tool(
		"delete_context_doc",
		"Delete a persistent context document.",
		{ filename: z.string().describe("Document name to delete") },
		async ({ filename }) => {
			try {
				await deleteStaticFile(userId, filename, env);
				return toolText(`Document '${filename}' deleted.`);
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.tool(
		"list_context_docs",
		"List all persistent context documents for this user.",
		{},
		async () => {
			try {
				const files = await listStaticFiles(userId, env);
				if (files.length === 0) return toolText("No context documents stored.");
				return toolText(
					`${files.length} context documents:\n${files.map((f) => `- ${f}`).join("\n")}`,
				);
			} catch (error) {
				return toolError(error);
			}
		},
	);
}
