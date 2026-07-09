import { v4 as uuidv4 } from "uuid";
import { keywordSearchMemories } from "./db";

const MINIMUM_SIMILARITY_SCORE = 0.4;

export async function generateEmbeddings(text: string, env: Env): Promise<number[]> {
    const embeddings = (await env.AI.run("@cf/baai/bge-m3", { text })) as AiTextEmbeddingsOutput;
    const values = embeddings.data[0];
    if (!values) throw new Error("Failed to generate vector embedding");
    return values;
}

export async function storeMemoryVector(id: string, text: string, userId: string, env: Env, metadata?: Record<string, string>): Promise<void> {
    const values = await generateEmbeddings(text, env);
    await env.VECTORIZE.upsert([{
        id,
        values,
        namespace: userId,
        metadata: { content: text, ...metadata },
    }]);
}

export async function searchMemories(
    query: string,
    userId: string,
    env: Env,
    topK: number = 10,
): Promise<Array<{ id: string; content: string; score: number }>> {
    const queryVector = await generateEmbeddings(query, env);
    const results = await env.VECTORIZE.query(queryVector, {
        namespace: userId,
        topK,
        returnMetadata: "all",
    });

    if (!results.matches?.length) return [];

    return results.matches
        .filter(m => m.score > MINIMUM_SIMILARITY_SCORE)
        .map(m => ({
            id: m.id,
            content: (m.metadata?.content as string) ?? `Missing content (ID: ${m.id})`,
            score: m.score ?? 0,
        }))
        .sort((a, b) => b.score - a.score);
}

/**
 * Semantic search with keyword fallback. If Vectorize or Workers AI is
 * unavailable (e.g. local dev without Cloudflare auth), falls back to a
 * D1 keyword search across text, subject, tags, and triggers so retrieval
 * keeps working. Returns the mode used alongside the results.
 */
export async function searchMemoriesWithFallback(
    query: string,
    userId: string,
    env: Env,
    topK: number = 10,
): Promise<{ results: Array<{ id: string; content: string; score: number }>; mode: "semantic" | "keyword" }> {
    try {
        const results = await searchMemories(query, userId, env, topK);
        return { results, mode: "semantic" };
    } catch (e) {
        console.error("Semantic search unavailable, using keyword fallback:", e);
        const results = await keywordSearchMemories(userId, query, env, topK);
        return { results, mode: "keyword" };
    }
}

export async function deleteVectorById(id: string, env: Env): Promise<void> {
    await env.VECTORIZE.deleteByIds([id]);
}

export async function deleteVectorsByIds(ids: string[], env: Env): Promise<void> {
    if (ids.length > 0) await env.VECTORIZE.deleteByIds(ids);
}
