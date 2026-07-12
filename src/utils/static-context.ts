/**
 * Dual-backend persistent documents:
 * - Prefer R2 when `env.R2` is bound (large files, many objects, binary-friendly)
 * - Fall back to KV for small text docs when R2 is absent
 *
 * Small "hot" docs (context_current, self_profile, living summary keys) may also
 * be mirrored to KV for fast session-brief reads.
 */

const HOT_DOCS = new Set([
	"context_current",
	"self_profile",
	"ai_personality",
	"context_core",
	"interaction_rules",
	"mood_tracker",
	"personality_styles",
]);

const kvKey = (userId: string, filename: string) => `static:${userId}:${filename}`;
const r2Key = (userId: string, filename: string) => `${userId}/${filename}`;

export function hasR2(env: Env): boolean {
	return Boolean((env as Env).R2);
}

export type StorageBackend = "r2" | "kv" | "both";

export async function storageStatus(env: Env): Promise<{
	r2: boolean;
	kv: boolean;
	preferred: "r2" | "kv";
	note: string;
}> {
	const r2 = hasR2(env);
	const kv = Boolean(env.KV);
	return {
		r2,
		kv,
		preferred: r2 ? "r2" : "kv",
		note: r2
			? "R2 is active for documents/blobs; hot docs also mirrored to KV."
			: "R2 not bound — using KV only. Enable R2 in the Cloudflare dashboard, create bucket mcp-memory-r2, redeploy.",
	};
}

export async function readStaticFile(
	userId: string,
	filename: string,
	env: Env,
): Promise<string | null> {
	// Prefer R2 for source of truth when present
	if (hasR2(env)) {
		try {
			const obj = await env.R2!.get(r2Key(userId, filename));
			if (obj) return await obj.text();
		} catch (e) {
			console.error("R2 read failed, trying KV:", e);
		}
	}
	return await env.KV.get(kvKey(userId, filename));
}

export async function writeStaticFile(
	userId: string,
	filename: string,
	content: string,
	env: Env,
): Promise<{ backend: StorageBackend }> {
	const safe = filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
	let wroteR2 = false;
	let wroteKv = false;

	if (hasR2(env)) {
		await env.R2!.put(r2Key(userId, safe), content, {
			httpMetadata: {
				contentType: contentTypeFor(safe),
			},
			customMetadata: {
				userId,
				filename: safe,
				updatedAt: new Date().toISOString(),
			},
		});
		wroteR2 = true;
		// Mirror hot docs to KV for fast session briefs
		if (HOT_DOCS.has(safe) || content.length < 100_000) {
			await env.KV.put(kvKey(userId, safe), content);
			wroteKv = true;
		}
	} else {
		await env.KV.put(kvKey(userId, safe), content);
		wroteKv = true;
	}

	if (wroteR2 && wroteKv) return { backend: "both" };
	if (wroteR2) return { backend: "r2" };
	return { backend: "kv" };
}

export async function deleteStaticFile(
	userId: string,
	filename: string,
	env: Env,
): Promise<void> {
	const tasks: Promise<unknown>[] = [env.KV.delete(kvKey(userId, filename))];
	if (hasR2(env)) {
		tasks.push(env.R2!.delete(r2Key(userId, filename)));
	}
	await Promise.all(tasks);
}

export async function listStaticFiles(userId: string, env: Env): Promise<string[]> {
	const names = new Set<string>();

	if (hasR2(env)) {
		const listed = await env.R2!.list({ prefix: `${userId}/` });
		for (const o of listed.objects) {
			names.add(o.key.slice(userId.length + 1));
		}
		// Handle truncated lists
		let cursor = listed.truncated ? listed.cursor : undefined;
		while (cursor) {
			const page = await env.R2!.list({ prefix: `${userId}/`, cursor });
			for (const o of page.objects) {
				names.add(o.key.slice(userId.length + 1));
			}
			cursor = page.truncated ? page.cursor : undefined;
		}
	}

	// Merge KV keys (covers pre-R2 docs and hot mirrors)
	const prefix = `static:${userId}:`;
	let kvCursor: string | undefined;
	do {
		const page = await env.KV.list({ prefix, cursor: kvCursor });
		for (const key of page.keys) {
			names.add(key.name.slice(prefix.length));
		}
		kvCursor = page.list_complete ? undefined : page.cursor;
	} while (kvCursor);

	return [...names].filter(Boolean).sort();
}

/** Binary-friendly blob storage (base64 in/out when using text APIs). */
export async function writeBlob(
	userId: string,
	filename: string,
	data: ArrayBuffer | string,
	env: Env,
	contentType = "application/octet-stream",
): Promise<{ backend: "r2" | "kv"; bytes: number }> {
	const safe = filename.replace(/[^a-zA-Z0-9._/-]/g, "_").slice(0, 200);
	const body =
		typeof data === "string"
			? data
			: data;

	if (hasR2(env)) {
		const putBody = typeof data === "string" ? data : data;
		await env.R2!.put(r2Key(userId, `blobs/${safe}`), putBody, {
			httpMetadata: { contentType },
			customMetadata: { userId, kind: "blob" },
		});
		const bytes =
			typeof data === "string" ? new TextEncoder().encode(data).byteLength : data.byteLength;
		return { backend: "r2", bytes };
	}

	// KV fallback: store as text only (base64 expected for binary)
	const text = typeof data === "string" ? data : bufferToBase64(data);
	if (text.length > 20_000_000) {
		throw new Error("Blob too large for KV fallback; enable R2 for large files");
	}
	await env.KV.put(kvKey(userId, `blobs/${safe}`), text);
	return { backend: "kv", bytes: text.length };
}

export async function readBlob(
	userId: string,
	filename: string,
	env: Env,
): Promise<{ content: string; backend: "r2" | "kv" } | null> {
	const safe = filename.replace(/[^a-zA-Z0-9._/-]/g, "_").slice(0, 200);
	if (hasR2(env)) {
		const obj = await env.R2!.get(r2Key(userId, `blobs/${safe}`));
		if (obj) return { content: await obj.text(), backend: "r2" };
	}
	const kv = await env.KV.get(kvKey(userId, `blobs/${safe}`));
	if (kv) return { content: kv, backend: "kv" };
	return null;
}

export async function listBlobs(userId: string, env: Env): Promise<string[]> {
	const names = new Set<string>();
	if (hasR2(env)) {
		const prefix = `${userId}/blobs/`;
		const listed = await env.R2!.list({ prefix });
		for (const o of listed.objects) {
			names.add(o.key.slice(prefix.length));
		}
	}
	const kvPrefix = `static:${userId}:blobs/`;
	let cursor: string | undefined;
	do {
		const page = await env.KV.list({ prefix: kvPrefix, cursor });
		for (const key of page.keys) {
			names.add(key.name.slice(kvPrefix.length));
		}
		cursor = page.list_complete ? undefined : page.cursor;
	} while (cursor);
	return [...names].sort();
}

export async function deleteBlob(userId: string, filename: string, env: Env): Promise<void> {
	const safe = filename.replace(/[^a-zA-Z0-9._/-]/g, "_").slice(0, 200);
	const tasks: Promise<unknown>[] = [env.KV.delete(kvKey(userId, `blobs/${safe}`))];
	if (hasR2(env)) {
		tasks.push(env.R2!.delete(r2Key(userId, `blobs/${safe}`)));
	}
	await Promise.all(tasks);
}

/** Copy all KV static docs into R2 (no-op if R2 missing). */
export async function migrateKvDocsToR2(
	userId: string,
	env: Env,
): Promise<{ migrated: number; skipped: boolean; error?: string }> {
	if (!hasR2(env)) {
		return { migrated: 0, skipped: true, error: "R2 not bound" };
	}
	const files = await listStaticFiles(userId, env);
	let migrated = 0;
	for (const name of files) {
		if (name.startsWith("blobs/")) continue;
		const content = await env.KV.get(kvKey(userId, name));
		if (!content) continue;
		await env.R2!.put(r2Key(userId, name), content, {
			httpMetadata: { contentType: contentTypeFor(name) },
		});
		migrated++;
	}
	return { migrated, skipped: false };
}

function contentTypeFor(filename: string): string {
	if (filename.endsWith(".md")) return "text/markdown; charset=utf-8";
	if (filename.endsWith(".json")) return "application/json";
	if (filename.endsWith(".html")) return "text/html; charset=utf-8";
	if (filename.endsWith(".txt")) return "text/plain; charset=utf-8";
	if (filename.endsWith(".pdf")) return "application/pdf";
	if (filename.endsWith(".png")) return "image/png";
	if (filename.endsWith(".jpg") || filename.endsWith(".jpeg")) return "image/jpeg";
	return "text/plain; charset=utf-8";
}

function bufferToBase64(buf: ArrayBuffer): string {
	const bytes = new Uint8Array(buf);
	let binary = "";
	for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
	return btoa(binary);
}
