/**
 * Cross-talk utility layer — propagates side effects across tool subsystems.
 *
 * This is NOT a pub/sub event bus. Each function is an explicit call that tools
 * invoke when significant operations happen. Simple, traceable, no magic.
 */
import { insertSessionLog, insertBehavioralObservation, insertMemory, listAiNotes, getBehavioralObservations } from "./db";
import { deleteKV, getKV, putKV } from "./kv";

// ── Living Summary Invalidation ──

/**
 * Marks the living summary as stale by deleting the cached version.
 * The next call to `get_session_brief` or `rebuild_living_summary` will regenerate it.
 */
export async function invalidateLivingSummary(userId: string, env: Env): Promise<void> {
	await deleteKV(`living_summary:${userId}`, env).catch((err) =>
		console.error("[cross-talk] Failed to invalidate living summary:", err),
	);
}

// ── Session Log Helpers ──

const SYSTEM_SESSION = "system";

async function logToSession(userId: string, content: string, env: Env): Promise<void> {
	await insertSessionLog(userId, SYSTEM_SESSION, "audit", content, env).catch((err) =>
		console.error("[cross-talk] Failed to log to session:", err),
	);
}

// ── Cross-Talk Functions ──

/**
 * Called after a single memory write/edit/suppress/forget.
 * Invalidates living summary, logs to session, and records behavioral observation
 * if the category is corrections or preferences.
 */
export async function onMemoryWrite(
	userId: string,
	memoryId: string,
	text: string,
	category: string,
	action: "write" | "edit" | "suppress" | "forget" | "restore",
	env: Env,
): Promise<void> {
	const tasks: Promise<void>[] = [
		invalidateLivingSummary(userId, env),
		logToSession(userId, `Memory ${action}: [${category}] ${text.slice(0, 120)}`, env),
	];

	if (category === "corrections" || category === "preferences") {
		tasks.push(
			insertBehavioralObservation(
				userId,
				`memory_${action}`,
				`User ${action === "write" ? "stated" : action + "d"} ${category}: ${text.slice(0, 200)}`,
				`memory_id:${memoryId}`,
				env,
			).then(() => {}),
		);
	}

	await Promise.allSettled(tasks);
}

/**
 * Called after batch memory operations (batch_write, import, consolidation).
 * Invalidates living summary and logs the batch to session.
 */
export async function onMemoryBatch(
	userId: string,
	count: number,
	source: string,
	env: Env,
): Promise<void> {
	await Promise.allSettled([
		invalidateLivingSummary(userId, env),
		logToSession(userId, `Batch memory ${source}: ${count} memories affected`, env),
	]);
}

/**
 * Called when a session starts. Records a behavioral observation for usage patterns.
 */
export async function onSessionStart(
	userId: string,
	sessionId: string,
	env: Env,
): Promise<void> {
	await insertBehavioralObservation(
		userId,
		"session_start",
		`Session ${sessionId} started at ${new Date().toISOString()}`,
		null,
		env,
	).catch((err) => console.error("[cross-talk] Failed to record session start:", err));
}

/**
 * Called when a session closes. Invalidates living summary and records usage patterns.
 */
export async function onSessionClose(
	userId: string,
	sessionId: string,
	summary: string,
	env: Env,
): Promise<void> {
	await Promise.allSettled([
		invalidateLivingSummary(userId, env),
		insertBehavioralObservation(
			userId,
			"session_close",
			`Session ${sessionId} closed. Summary: ${summary.slice(0, 200)}`,
			null,
			env,
		),
	]);
}

/**
 * Called when a person is added, updated, or deleted.
 * Logs the change to session history.
 */
export async function onPersonChange(
	userId: string,
	personName: string,
	action: "add" | "update" | "delete",
	env: Env,
): Promise<void> {
	await logToSession(userId, `Person ${action}: ${personName}`, env);
}

/**
 * Called after transcript ingestion completes.
 * Invalidates living summary and logs ingestion activity.
 */
export async function onIngestion(
	userId: string,
	transcriptId: string,
	extractedCount: number,
	env: Env,
): Promise<void> {
	await Promise.allSettled([
		invalidateLivingSummary(userId, env),
		logToSession(userId, `Ingested transcript ${transcriptId}: extracted ${extractedCount} memories`, env),
	]);
}

/**
 * Called when an uncertainty is resolved with a user answer.
 * Auto-creates a memory from the question + answer.
 */
export async function onUncertaintyResolved(
	userId: string,
	question: string,
	answer: string,
	env: Env,
): Promise<string> {
	const memory = await insertMemory(
		{
			userId,
			text: `Q: ${question} A: ${answer}`,
			category: "knowledge",
			layer: "current",
			source_type: "stated",
			confidence: 0.95,
			salience: 0.6,
			tags: ["from_uncertainty"],
		},
		env,
	);

	await Promise.allSettled([
		invalidateLivingSummary(userId, env),
		logToSession(userId, `Uncertainty resolved → memory created: ${question.slice(0, 80)}`, env),
	]);

	return memory.id;
}

/**
 * Called when an AI agent writes a note. Logs the handoff to session history.
 */
export async function onAgentNoteWrite(
	userId: string,
	agentId: string,
	key: string,
	env: Env,
): Promise<void> {
	await logToSession(userId, `Agent note written: [${agentId}] ${key}`, env);
}

// ── Cross-Domain Context Helpers ──

/**
 * Fetches a compact cross-domain summary for use in session briefs.
 * Gathers behavioral, AI agent, and uncertainty context.
 */
export async function getCrossDomainContext(
	userId: string,
	env: Env,
): Promise<{
	behavioralSummary: string | null;
	recentAgentNotes: Array<{ agent_id: string; key: string; content: string }>;
	openUncertainties: number;
	recentObservations: Array<{ observation_type: string; content: string }>;
}> {
	const [behavioralCache, agentNotes, uncertaintyResult, observations] = await Promise.allSettled([
		getKV(`behavioral:${userId}`, env),
		listAiNotes(userId, env),
		env.DB.prepare("SELECT COUNT(*) as count FROM uncertainties WHERE userId=? AND status='open'")
			.bind(userId)
			.first<{ count: number }>(),
		getBehavioralObservations(userId, env, undefined, 5),
	]);

	return {
		behavioralSummary: behavioralCache.status === "fulfilled" ? behavioralCache.value : null,
		recentAgentNotes:
			agentNotes.status === "fulfilled"
				? (agentNotes.value as Array<{ agent_id: string; key: string; content: string }>).slice(0, 5)
				: [],
		openUncertainties:
			uncertaintyResult.status === "fulfilled" && uncertaintyResult.value
				? uncertaintyResult.value.count
				: 0,
		recentObservations:
			observations.status === "fulfilled"
				? observations.value.map((o) => ({
						observation_type: o.observation_type,
						content: o.content,
					}))
				: [],
	};
}
