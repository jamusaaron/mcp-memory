/**
 * Background maintenance for all tenants: bounded artifact cache purges,
 * bounded living-summary rebuilds, and legacy embedding backfill plus light
 * confidence decay. Invoked by the Worker cron trigger. Exactly one bounded
 * phase runs per invocation.
 */

import {
	getUnembeddedMemories,
	queryMemories,
	updateMemory,
} from "./utils/db";
import {
	listDueLivingSummaryTenants,
	purgeDueArtifactCaches,
} from "./utils/artifact-store";
import { rebuildDerivedArtifact } from "./utils/artifact-service";
import { storeMemoryVector } from "./utils/vectorize";
import { initializeDatabase } from "./schema";
import type { DatabaseInitializationResult } from "./migrations";

const LEGACY_MAINTENANCE_CURSOR_KEY = "maintenance:legacy-cursor:v1";
const MAX_MAINTENANCE_WALL_MS = 20_000;
const MAX_LEGACY_EMBEDDING_ATTEMPTS = 5;
const MAX_LEGACY_CONFIDENCE_ATTEMPTS = 2;

async function listActiveUserIds(
	env: Env,
	afterUserId: string | null,
	limit: number,
): Promise<string[]> {
	const boundedLimit = Math.min(3, Math.max(1, Math.trunc(limit)));
	const page = async (after: string | null) => {
		const result = await env.DB.prepare(
			`SELECT userId
			 FROM memories
			 WHERE (? IS NULL OR userId>?)
			 GROUP BY userId
			 ORDER BY userId ASC
			 LIMIT ?`,
		)
			.bind(after, after, boundedLimit)
			.all<{ userId: string }>();
		return result.results.map(({ userId }) => userId);
	};
	const selected = await page(afterUserId);
	return selected.length === 0 && afterUserId !== null
		? page(null)
		: selected;
}

async function readLegacyMaintenanceCursor(env: Env): Promise<string | null> {
	try {
		return await env.KV.get(LEGACY_MAINTENANCE_CURSOR_KEY);
	} catch {
		return null;
	}
}

async function writeLegacyMaintenanceCursor(
	env: Env,
	userId: string,
): Promise<void> {
	try {
		await env.KV.put(LEGACY_MAINTENANCE_CURSOR_KEY, userId);
	} catch {
		// Losing a cursor can repeat bounded work but cannot change correctness.
	}
}

async function safeLogId(value: string): Promise<string> {
	const bytes = new TextEncoder().encode(value);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("")
		.slice(0, 12);
}

export type MaintenanceDependencies = {
	now(): Date;
	monotonicNowMs(): number;
	initializeDatabase: typeof initializeDatabase;
	readLegacyMaintenanceCursor: typeof readLegacyMaintenanceCursor;
	writeLegacyMaintenanceCursor: typeof writeLegacyMaintenanceCursor;
	listActiveUserIds: typeof listActiveUserIds;
	getUnembeddedMemories: typeof getUnembeddedMemories;
	storeMemoryVector: typeof storeMemoryVector;
	updateMemory: typeof updateMemory;
	queryMemories: typeof queryMemories;
	purgeDueArtifactCaches: typeof purgeDueArtifactCaches;
	listDueLivingSummaryTenants: typeof listDueLivingSummaryTenants;
	rebuildDerivedArtifact: typeof rebuildDerivedArtifact;
	log(entry: Record<string, unknown>): void;
};

const DEFAULT_MAINTENANCE_DEPS: MaintenanceDependencies = {
	now: () => new Date(),
	monotonicNowMs: () => performance.now(),
	initializeDatabase,
	readLegacyMaintenanceCursor,
	writeLegacyMaintenanceCursor,
	listActiveUserIds,
	getUnembeddedMemories,
	storeMemoryVector,
	updateMemory,
	queryMemories,
	purgeDueArtifactCaches,
	listDueLivingSummaryTenants,
	rebuildDerivedArtifact,
	log: (entry) => console.log(JSON.stringify(entry)),
};

export async function runScheduledMaintenance(
	env: Env,
	overrides?: Partial<MaintenanceDependencies>,
): Promise<void> {
	const deps: MaintenanceDependencies = {
		...DEFAULT_MAINTENANCE_DEPS,
		...overrides,
	};
	const startedAt = deps.monotonicNowMs();
	const canStartUnit = () =>
		deps.monotonicNowMs() - startedAt < MAX_MAINTENANCE_WALL_MS;

	let initialization: DatabaseInitializationResult;
	try {
		initialization = await deps.initializeDatabase(env);
	} catch {
		deps.log({
			event: "database_initialization_failed",
			reason_code: "database_initialization_failed",
		});
		return;
	}
	if (!initialization.ready || initialization.changed) {
		deps.log({
			event: "maintenance_completed",
			phase: "schema",
			schema_ready: initialization.ready,
			schema_changed: initialization.changed,
			d1_statement_count: initialization.queryCount,
		});
		return;
	}
	if (initialization.queryCount !== 2) {
		deps.log({
			event: "database_initialization_failed",
			reason_code: "schema_budget_mismatch",
		});
		return;
	}

	const now = deps.now();
	try {
		const purge = await deps.purgeDueArtifactCaches(env, 10, now);
		deps.log({
			event: "artifact_cache_purge_completed",
			attempted_count: purge.attempted,
			purged_count: purge.purged,
			failed_count: purge.failed,
		});
		if (purge.attempted > 0) {
			deps.log({ event: "maintenance_completed", phase: "cache_purge" });
			return;
		}
	} catch {
		deps.log({
			event: "artifact_cache_purge_sweep_failed",
			reason_code: "cache_purge_sweep_failed",
		});
		return;
	}

	if (!canStartUnit()) {
		deps.log({ event: "maintenance_completed", phase: "deadline" });
		return;
	}

	let dueTenants: string[];
	try {
		dueTenants = [
			...new Set(
				await deps.listDueLivingSummaryTenants(env, 1, now.toISOString()),
			),
		].slice(0, 1);
	} catch {
		deps.log({
			event: "artifact_rebuild_selection_failed",
			reason_code: "rebuild_selection_failed",
		});
		return;
	}
	if (dueTenants.length === 1) {
		const userId = dueTenants[0];
		const tenant = await safeLogId(userId);
		try {
			const result = await deps.rebuildDerivedArtifact(
				userId,
				"living_summary",
				env,
			);
			deps.log({
				event: "artifact_rebuild_published",
				tenant,
				kind: "living_summary",
				artifact_id_hash: await safeLogId(result.artifact.id),
				reused: result.reused,
			});
		} catch {
			deps.log({
				event: "artifact_rebuild_failed",
				tenant,
				kind: "living_summary",
				reason_code: "generation_failed",
			});
		}
		deps.log({ event: "maintenance_completed", phase: "artifact_rebuild" });
		return;
	}

	if (!canStartUnit()) {
		deps.log({ event: "maintenance_completed", phase: "deadline" });
		return;
	}

	let cursor: string | null;
	let userIds: string[];
	try {
		cursor = await deps.readLegacyMaintenanceCursor(env);
		userIds = await deps.listActiveUserIds(env, cursor, 3);
	} catch {
		deps.log({
			event: "legacy_maintenance_selection_failed",
			reason_code: "maintenance_selection_failed",
		});
		return;
	}

	let embeddingAttempts = 0;
	let confidenceAttempts = 0;
	let tenantCount = 0;
	for (const userId of userIds) {
		if (!canStartUnit()) break;
		tenantCount += 1;
		const tenant = await safeLogId(userId);
		try {
			if (
				embeddingAttempts < MAX_LEGACY_EMBEDDING_ATTEMPTS &&
				canStartUnit()
			) {
				const pending = await deps.getUnembeddedMemories(
					userId,
					env,
					Math.min(
						20,
						MAX_LEGACY_EMBEDDING_ATTEMPTS - embeddingAttempts,
					),
				);
				for (const memory of pending) {
					if (
						embeddingAttempts >= MAX_LEGACY_EMBEDDING_ATTEMPTS ||
						!canStartUnit()
					) break;
					embeddingAttempts += 1;
					try {
						await deps.storeMemoryVector(memory.id, memory.text, userId, env, {
							category: memory.category,
							layer: memory.layer,
							salience: memory.salience,
							pinned: memory.pinned ? 1 : 0,
						});
						await deps.updateMemory(
							memory.id,
							userId,
							{ embedding_status: "embedded" },
							env,
						);
					} catch {
						deps.log({
							event: "embedding_backfill_failed",
							tenant,
							memory_id_hash: await safeLogId(memory.id),
							reason_code: "embedding_failed",
						});
					}
				}
			}

			if (
				confidenceAttempts < MAX_LEGACY_CONFIDENCE_ATTEMPTS &&
				canStartUnit()
			) {
				const thirtyDaysAgo = new Date(
					now.getTime() - 30 * 86_400_000,
				).toISOString();
				const memories = await deps.queryMemories(userId, env, {
					suppressed: false,
					limit: 20,
				});
				for (const memory of memories) {
					if (memory.layer === "core" || memory.pinned) continue;
					if (
						memory.last_verified &&
						memory.last_verified > thirtyDaysAgo
					) continue;
					const ageDays =
						(now.getTime() - new Date(memory.created_at).getTime()) /
						86_400_000;
					if (ageDays < 30) continue;
					const confidence = Math.max(0.3, memory.confidence - 0.01);
					if (confidence >= memory.confidence) continue;
					if (
						confidenceAttempts >= MAX_LEGACY_CONFIDENCE_ATTEMPTS ||
						!canStartUnit()
					) break;
					confidenceAttempts += 1;
					try {
						await deps.updateMemory(
							memory.id,
							userId,
							{ confidence },
							env,
						);
					} catch {
						deps.log({
							event: "confidence_decay_failed",
							tenant,
							memory_id_hash: await safeLogId(memory.id),
							reason_code: "confidence_update_failed",
						});
					}
				}
			}
		} catch {
			deps.log({
				event: "maintenance_tenant_failed",
				tenant,
				reason_code: "maintenance_failed",
			});
		}
		await deps.writeLegacyMaintenanceCursor(env, userId);
		if (
			embeddingAttempts >= MAX_LEGACY_EMBEDDING_ATTEMPTS &&
			confidenceAttempts >= MAX_LEGACY_CONFIDENCE_ATTEMPTS
		) break;
	}

	deps.log({
		event: "maintenance_completed",
		phase: "legacy",
		tenant_count: tenantCount,
		embedding_attempt_count: embeddingAttempts,
		confidence_attempt_count: confidenceAttempts,
	});
}
