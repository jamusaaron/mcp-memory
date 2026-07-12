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
 * Persistent context documents. Prefer R2 when bound; otherwise KV.
 * Hot docs are mirrored to KV for fast session briefs.
 */
export function registerContextDocTools(server: McpServer, env: Env, userId: string) {
	server.tool(
		"read_context_doc",
		"Read a persistent context document (R2 when available, else KV). Common names: context_current, context_core, interaction_rules, ai_personality, self_profile, mood_tracker, personality_styles.",
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
		"Create or overwrite a persistent context document. Uses R2 when bound (mirrored to KV for hot docs); otherwise KV only.",
		{
			filename: z.string().describe("Document name"),
			content: z.string().describe("Document content (markdown recommended)"),
		},
		async ({ filename, content }) => {
			try {
				const safe = filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
				const result = await writeStaticFile(userId, safe, content, env);
				return toolText(
					`Document '${safe}' saved via ${result.backend} (${content.length} chars).`,
				);
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.tool(
		"delete_context_doc",
		"Delete a persistent context document from R2 and/or KV.",
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
		"List all persistent context documents (union of R2 and KV keys).",
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
