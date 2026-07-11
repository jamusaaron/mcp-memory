/**
 * Background maintenance for all tenants: backfill embeddings and light decay.
 * Invoked by the Worker cron trigger.
 */

import { getUnembeddedMemories, queryMemories, updateMemory } from "./utils/db";
import { storeMemoryVector } from "./utils/vectorize";

async function listActiveUserIds(env: Env, limit = 50): Promise<string[]> {
	const res = await env.DB.prepare(
		`SELECT userId, MAX(updated_at) as last_u
     FROM memories
     GROUP BY userId
     ORDER BY last_u DESC
     LIMIT ?`,
	)
		.bind(limit)
		.all();
	return (res.results as Array<{ userId: string }>).map((r) => r.userId);
}

export async function runScheduledMaintenance(env: Env): Promise<void> {
	const userIds = await listActiveUserIds(env);
	console.log(`Maintenance: processing ${userIds.length} tenants`);

	for (const userId of userIds) {
		try {
			// 1) Backfill embeddings
			const pending = await getUnembeddedMemories(userId, env);
			for (const m of pending.slice(0, 20)) {
				try {
					await storeMemoryVector(m.id, m.text, userId, env, {
						category: m.category,
						layer: m.layer,
						salience: m.salience,
						pinned: m.pinned ? 1 : 0,
					});
					await updateMemory(m.id, userId, { embedding_status: "embedded" } as any, env);
				} catch (e) {
					console.error(`embed fail ${m.id}:`, e);
				}
			}

			// 2) Light confidence decay for stale non-core memories
			const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
			const memories = await queryMemories(userId, env, { suppressed: false, limit: 100 });
			for (const m of memories) {
				if (m.layer === "core" || m.pinned) continue;
				if (m.last_verified && m.last_verified > thirtyDaysAgo) continue;
				const ageDays = (Date.now() - new Date(m.created_at).getTime()) / 86400000;
				if (ageDays < 30) continue;
				const newConf = Math.max(0.3, m.confidence - 0.01);
				if (newConf < m.confidence) {
					await updateMemory(m.id, userId, { confidence: newConf } as any, env);
				}
			}
		} catch (e) {
			console.error(`Maintenance failed for ${userId}:`, e);
		}
	}

	console.log("Maintenance complete");
}
