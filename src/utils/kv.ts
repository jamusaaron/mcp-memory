import { z } from "zod";
import type { ArtifactKind } from "../types";
import {
	artifactClaimsSchema,
	artifactContentSha256,
} from "./artifact-synthesis";

export async function getKV(key: string, env: Env): Promise<string | null> {
    return await env.KV.get(key);
}

export async function putKV(key: string, value: string, env: Env, expirationTtl?: number): Promise<void> {
    const opts: KVNamespacePutOptions = {};
    if (expirationTtl) opts.expirationTtl = expirationTtl;
    await env.KV.put(key, value, opts);
}

export async function deleteKV(key: string, env: Env): Promise<void> {
    await env.KV.delete(key);
}

export async function getLivingSummary(userId: string, env: Env): Promise<string | null> {
    return getKV(`living_summary:${userId}`, env);
}

export async function putLivingSummary(userId: string, summary: string, env: Env): Promise<void> {
    await putKV(`living_summary:${userId}`, summary, env);
}

export async function getPersonalityCache(userId: string, env: Env): Promise<string | null> {
    return getKV(`personality:${userId}`, env);
}

export async function putPersonalityCache(userId: string, data: string, env: Env): Promise<void> {
    await putKV(`personality:${userId}`, data, env, 3600);
}

export async function getBehavioralCache(userId: string, env: Env): Promise<string | null> {
    return getKV(`behavioral:${userId}`, env);
}

export async function putBehavioralCache(userId: string, data: string, env: Env): Promise<void> {
    await putKV(`behavioral:${userId}`, data, env, 3600);
}

export async function getSessionState(userId: string, sessionId: string, env: Env): Promise<string | null> {
    return getKV(`session:${userId}:${sessionId}`, env);
}

export async function putSessionState(userId: string, sessionId: string, state: string, env: Env): Promise<void> {
    await putKV(`session:${userId}:${sessionId}`, state, env, 86400);
}

// ---- Immutable trusted-artifact cache envelopes ----

const MAX_ARTIFACT_CACHE_BYTES = 1024 * 1024;

const artifactCacheEnvelopeSchema = z
	.object({
		artifactId: z.string().min(1).max(200),
		contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
		claims: artifactClaimsSchema,
		renderedText: z.string().max(500_000),
	})
	.strict();

export type ArtifactCacheEnvelope = z.infer<typeof artifactCacheEnvelopeSchema>;

export const artifactCacheKey = (
	userId: string,
	kind: ArtifactKind,
	artifactId: string,
): string => `artifact:${userId}:${kind}:${artifactId}`;

export async function getArtifactCache(
	userId: string,
	kind: ArtifactKind,
	artifactId: string,
	expectedContentSha256: string,
	env: Env,
): Promise<ArtifactCacheEnvelope | null> {
	const raw = await getKV(artifactCacheKey(userId, kind, artifactId), env);
	if (!raw) return null;
	try {
		if (new TextEncoder().encode(raw).byteLength > MAX_ARTIFACT_CACHE_BYTES) {
			return null;
		}
		const parsed = artifactCacheEnvelopeSchema.safeParse(JSON.parse(raw));
		if (!parsed.success || parsed.data.artifactId !== artifactId) return null;
		const recomputed = await artifactContentSha256(
			parsed.data.claims,
			parsed.data.renderedText,
		);
		return recomputed === parsed.data.contentSha256 &&
			recomputed === expectedContentSha256
			? parsed.data
			: null;
	} catch {
		return null;
	}
}

export async function putArtifactCache(
	userId: string,
	kind: ArtifactKind,
	envelope: ArtifactCacheEnvelope,
	env: Env,
): Promise<void> {
	const validated = artifactCacheEnvelopeSchema.parse(envelope);
	const recomputed = await artifactContentSha256(
		validated.claims,
		validated.renderedText,
	);
	if (recomputed !== validated.contentSha256) {
		throw new Error("Artifact cache content hash mismatch");
	}
	const serialized = JSON.stringify(validated);
	if (
		new TextEncoder().encode(serialized).byteLength > MAX_ARTIFACT_CACHE_BYTES
	) {
		throw new Error("Artifact cache envelope is oversized");
	}
	await putKV(
		artifactCacheKey(userId, kind, validated.artifactId),
		serialized,
		env,
	);
}

export async function deleteArtifactCache(
	userId: string,
	kind: ArtifactKind,
	artifactId: string,
	env: Env,
): Promise<void> {
	await deleteKV(artifactCacheKey(userId, kind, artifactId), env);
}
