import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	deleteBlob,
	listBlobs,
	migrateKvDocsToR2,
	readBlob,
	storageStatus,
	writeBlob,
} from "../utils/static-context";
import { toolError, toolText } from "../utils/tool-result";

/**
 * Large-object storage tools. Prefer R2 when bound; fall back to KV for small text.
 */
export function registerBlobTools(server: McpServer, env: Env, userId: string) {
	server.tool(
		"storage_status",
		"Report which document backends are active (R2 and/or KV) and which is preferred for new writes.",
		{},
		async () => {
			try {
				const s = await storageStatus(env);
				return toolText(
					`Storage status:\n- R2: ${s.r2 ? "active" : "not bound"}\n- KV: ${s.kv ? "active" : "missing"}\n- Preferred: ${s.preferred}\n- ${s.note}`,
				);
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.tool(
		"store_blob",
		"Store a large document or text blob (evidence export, transcript dump, PDF as base64, etc.). Uses R2 when available; KV only for smaller text.",
		{
			filename: z
				.string()
				.describe("Filename under blobs/ (e.g. 'fair-work/submission-v3.md')"),
			content: z
				.string()
				.describe("Text content, or base64 for binary files"),
			content_type: z
				.string()
				.optional()
				.default("text/plain; charset=utf-8")
				.describe("MIME type"),
		},
		async ({ filename, content, content_type }) => {
			try {
				const result = await writeBlob(userId, filename, content, env, content_type);
				return toolText(
					`Blob stored as '${filename}' via ${result.backend} (${result.bytes} bytes).`,
				);
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.tool(
		"read_blob",
		"Read a previously stored blob by filename.",
		{ filename: z.string().describe("Blob filename (without blobs/ prefix if omitted)") },
		async ({ filename }) => {
			try {
				const name = filename.replace(/^blobs\//, "");
				const result = await readBlob(userId, name, env);
				if (!result) return toolText(`Blob '${name}' not found.`);
				const preview =
					result.content.length > 50_000
						? result.content.slice(0, 50_000) +
							`\n\n…[truncated ${result.content.length} chars total]`
						: result.content;
				return toolText(`# Blob ${name} (${result.backend})\n\n${preview}`);
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.tool(
		"list_blobs",
		"List stored blobs (large documents/evidence files) for this user.",
		{},
		async () => {
			try {
				const files = await listBlobs(userId, env);
				if (files.length === 0) return toolText("No blobs stored.");
				return toolText(
					`${files.length} blobs:\n${files.map((f) => `- ${f}`).join("\n")}`,
				);
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.tool(
		"delete_blob",
		"Delete a stored blob from R2/KV.",
		{ filename: z.string() },
		async ({ filename }) => {
			try {
				const name = filename.replace(/^blobs\//, "");
				await deleteBlob(userId, name, env);
				return toolText(`Blob '${name}' deleted.`);
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.tool(
		"migrate_docs_to_r2",
		"Copy existing KV context documents into R2 once R2 is enabled. Safe to re-run (overwrites same keys).",
		{},
		async () => {
			try {
				const result = await migrateKvDocsToR2(userId, env);
				if (result.skipped) {
					return toolText(
						`Migration skipped: ${result.error}. Enable R2 in Cloudflare Dashboard → R2 → Purchase/Enable, create bucket mcp-memory-r2, then redeploy.`,
					);
				}
				return toolText(`Migrated ${result.migrated} documents from KV → R2.`);
			} catch (error) {
				return toolError(error);
			}
		},
	);
}
