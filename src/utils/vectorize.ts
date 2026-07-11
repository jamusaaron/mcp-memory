const MINIMUM_SIMILARITY_SCORE = 0.4;

export type VectorMatch = {
	id: string;
	content: string;
	score: number;
	category?: string;
	layer?: string;
	salience?: number;
};

export async function generateEmbeddings(text: string, env: Env): Promise<number[]> {
	const embeddings = (await env.AI.run("@cf/baai/bge-m3", { text })) as AiTextEmbeddingsOutput;
	const values = embeddings.data[0];
	if (!values) throw new Error("Failed to generate vector embedding");
	return values;
}

export async function storeMemoryVector(
	id: string,
	text: string,
	userId: string,
	env: Env,
	metadata?: Record<string, string | number | boolean>,
): Promise<void> {
	const values = await generateEmbeddings(text, env);
	// Vectorize metadata values must be string | number | boolean
	const meta: Record<string, string | number | boolean> = {
		content: text.slice(0, 8000),
		...metadata,
	};
	await env.VECTORIZE.upsert([
		{
			id,
			values,
			namespace: userId,
			metadata: meta,
		},
	]);
}

export async function searchMemories(
	query: string,
	userId: string,
	env: Env,
	topK: number = 10,
	options?: {
		minScore?: number;
		filter?: VectorizeVectorMetadataFilter;
	},
): Promise<VectorMatch[]> {
	const queryVector = await generateEmbeddings(query, env);
	const minScore = options?.minScore ?? MINIMUM_SIMILARITY_SCORE;

	const queryOptions: VectorizeQueryOptions = {
		namespace: userId,
		topK,
		returnMetadata: "all",
	};
	if (options?.filter) {
		queryOptions.filter = options.filter;
	}

	const results = await env.VECTORIZE.query(queryVector, queryOptions);

	if (!results.matches?.length) return [];

	return results.matches
		.filter((m) => (m.score ?? 0) > minScore)
		.map((m) => ({
			id: m.id,
			content: (m.metadata?.content as string) ?? `Missing content (ID: ${m.id})`,
			score: m.score ?? 0,
			category: m.metadata?.category as string | undefined,
			layer: m.metadata?.layer as string | undefined,
			salience:
				typeof m.metadata?.salience === "number"
					? m.metadata.salience
					: Number(m.metadata?.salience) || undefined,
		}))
		.sort((a, b) => b.score - a.score);
}

/**
 * Re-rank vector hits by blending similarity with salience, confidence proxies,
 * and keyword overlap for hybrid retrieval quality.
 */
export function rerankMatches(
	query: string,
	matches: VectorMatch[],
	boosts?: Map<string, { salience?: number; confidence?: number; pinned?: boolean; access_count?: number }>,
): VectorMatch[] {
	const tokens = tokenize(query);
	return matches
		.map((m) => {
			const b = boosts?.get(m.id);
			const keywordBoost = tokens.length
				? tokens.filter((t) => m.content.toLowerCase().includes(t)).length / tokens.length
				: 0;
			const salienceBoost = (b?.salience ?? m.salience ?? 0.5) * 0.15;
			const confidenceBoost = (b?.confidence ?? 0.7) * 0.1;
			const pinBoost = b?.pinned ? 0.12 : 0;
			const accessBoost = Math.min(0.08, ((b?.access_count ?? 0) / 50) * 0.08);
			const blended =
				m.score * 0.7 + keywordBoost * 0.15 + salienceBoost + confidenceBoost + pinBoost + accessBoost;
			return { ...m, score: blended };
		})
		.sort((a, b) => b.score - a.score);
}

function tokenize(query: string): string[] {
	return query
		.toLowerCase()
		.split(/[^a-z0-9_]+/)
		.filter((t) => t.length > 2);
}

export async function deleteVectorById(id: string, env: Env): Promise<void> {
	await env.VECTORIZE.deleteByIds([id]);
}

export async function deleteVectorsByIds(ids: string[], env: Env): Promise<void> {
	if (ids.length > 0) await env.VECTORIZE.deleteByIds(ids);
}
