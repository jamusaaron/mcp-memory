import { v4 as uuidv4 } from "uuid";
import type {
	AgentRun,
	AiNote,
	BehavioralObservation,
	Memory,
	MemoryIndex,
	PendingUpdate,
	Person,
	PersonProfile,
	PersonalityFeedback,
	SessionLog,
	Transcript,
	Uncertainty,
} from "../types";

function parseJsonField<T>(val: unknown, fallback: T): T {
	if (typeof val === "string") {
		try {
			return JSON.parse(val);
		} catch {
			return fallback;
		}
	}
	return fallback;
}

function rowToMemory(row: Record<string, unknown>): Memory {
	return {
		...row,
		tags: parseJsonField(row.tags, []),
		triggers: parseJsonField(row.triggers, []),
		linked_people: parseJsonField(row.linked_people, []),
		suppressed: Boolean(row.suppressed),
		pinned: Boolean(row.pinned),
		access_count: Number(row.access_count ?? 0),
	} as unknown as Memory;
}

// ── Memory CRUD ──

export async function insertMemory(
	m: Partial<Memory> & { userId: string; text: string },
	env: Env,
): Promise<Memory> {
	const id = m.id ?? uuidv4();
	const now = new Date().toISOString();
	await env.DB.prepare(
		`INSERT INTO memories (id,userId,category,layer,subject,text,tags,triggers,confidence,salience,emotion_weight,source_type,linked_people,embedding_status,suppressed,suppression_reason,pinned,access_count,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
	)
		.bind(
			id,
			m.userId,
			m.category ?? "knowledge",
			m.layer ?? "current",
			m.subject ?? null,
			m.text,
			JSON.stringify(m.tags ?? []),
			JSON.stringify(m.triggers ?? []),
			m.confidence ?? 0.8,
			m.salience ?? 0.5,
			m.emotion_weight ?? 0.0,
			m.source_type ?? "stated",
			JSON.stringify(m.linked_people ?? []),
			"pending",
			0,
			null,
			m.pinned ? 1 : 0,
			m.access_count ?? 0,
			now,
			now,
		)
		.run();
	return getMemoryById(id, m.userId, env) as Promise<Memory>;
}

export async function getMemoryById(id: string, userId: string, env: Env): Promise<Memory | null> {
	const row = await env.DB.prepare("SELECT * FROM memories WHERE id=? AND userId=?")
		.bind(id, userId)
		.first();
	return row ? rowToMemory(row as Record<string, unknown>) : null;
}

export async function updateMemory(
	id: string,
	userId: string,
	updates: Partial<Memory>,
	env: Env,
): Promise<void> {
	const sets: string[] = [];
	const vals: unknown[] = [];
	for (const [k, v] of Object.entries(updates)) {
		if (["id", "userId", "created_at"].includes(k)) continue;
		let val: unknown = v;
		if (Array.isArray(v)) val = JSON.stringify(v);
		else if (typeof v === "boolean") val = v ? 1 : 0;
		sets.push(`${k}=?`);
		vals.push(val);
	}
	sets.push("updated_at=?");
	vals.push(new Date().toISOString());
	vals.push(id, userId);
	const result = await env.DB.prepare(
		`UPDATE memories SET ${sets.join(",")} WHERE id=? AND userId=?`,
	)
		.bind(...vals)
		.run();
	if (result.meta.changes === 0) {
		throw new Error(`Memory ${id} not found`);
	}
}

export async function deleteMemory(id: string, userId: string, env: Env): Promise<void> {
	const result = await env.DB.prepare("DELETE FROM memories WHERE id=? AND userId=?")
		.bind(id, userId)
		.run();
	if (result.meta.changes === 0) {
		throw new Error(`Memory ${id} not found`);
	}
}

export async function queryMemories(
	userId: string,
	env: Env,
	filters?: {
		category?: string;
		layer?: string;
		suppressed?: boolean;
		limit?: number;
		offset?: number;
	},
): Promise<Memory[]> {
	let sql = "SELECT * FROM memories WHERE userId=?";
	const params: unknown[] = [userId];
	if (filters?.category) {
		sql += " AND category=?";
		params.push(filters.category);
	}
	if (filters?.layer) {
		sql += " AND layer=?";
		params.push(filters.layer);
	}
	if (filters?.suppressed !== undefined) {
		sql += " AND suppressed=?";
		params.push(filters.suppressed ? 1 : 0);
	}
	sql += " ORDER BY created_at DESC";
	if (filters?.limit) {
		sql += " LIMIT ?";
		params.push(filters.limit);
	}
	if (filters?.offset) {
		sql += " OFFSET ?";
		params.push(filters.offset);
	}
	const res = await env.DB.prepare(sql)
		.bind(...params)
		.all();
	return (res.results as Record<string, unknown>[]).map(rowToMemory);
}

export async function queryMemoriesByDate(
	userId: string,
	start: string,
	end: string,
	env: Env,
	filters?: { category?: string; layer?: string },
): Promise<Memory[]> {
	let sql = "SELECT * FROM memories WHERE userId=? AND created_at>=? AND created_at<=?";
	const params: unknown[] = [userId, start, end];
	if (filters?.category) {
		sql += " AND category=?";
		params.push(filters.category);
	}
	if (filters?.layer) {
		sql += " AND layer=?";
		params.push(filters.layer);
	}
	sql += " ORDER BY created_at DESC";
	const res = await env.DB.prepare(sql)
		.bind(...params)
		.all();
	return (res.results as Record<string, unknown>[]).map(rowToMemory);
}

export async function getMemoryIndex(userId: string, env: Env): Promise<MemoryIndex> {
	const cats = await env.DB.prepare(
		"SELECT category, COUNT(*) as cnt FROM memories WHERE userId=? AND suppressed=0 GROUP BY category",
	)
		.bind(userId)
		.all();
	const layers = await env.DB.prepare(
		"SELECT layer, COUNT(*) as cnt FROM memories WHERE userId=? AND suppressed=0 GROUP BY layer",
	)
		.bind(userId)
		.all();
	const total = (await env.DB.prepare(
		"SELECT COUNT(*) as total, SUM(CASE WHEN embedding_status='embedded' THEN 1 ELSE 0 END) as embedded, SUM(CASE WHEN embedding_status='pending' THEN 1 ELSE 0 END) as pending, SUM(CASE WHEN suppressed=1 THEN 1 ELSE 0 END) as suppressed FROM memories WHERE userId=?",
	)
		.bind(userId)
		.first()) as Record<string, number>;

	const by_category: Record<string, number> = {};
	for (const r of cats.results as any[]) by_category[r.category] = r.cnt;
	const by_layer: Record<string, number> = {};
	for (const r of layers.results as any[]) by_layer[r.layer] = r.cnt;

	return {
		total: total.total ?? 0,
		by_category,
		by_layer,
		embedded: total.embedded ?? 0,
		pending_embedding: total.pending ?? 0,
		suppressed: total.suppressed ?? 0,
	};
}

export async function getMemoriesNeedingReverification(
	userId: string,
	env: Env,
	daysOld = 30,
): Promise<Memory[]> {
	const cutoff = new Date(Date.now() - daysOld * 86400000).toISOString();
	const res = await env.DB.prepare(
		"SELECT * FROM memories WHERE userId=? AND suppressed=0 AND confidence<0.6 AND (last_verified IS NULL OR last_verified<?) ORDER BY confidence ASC LIMIT 50",
	)
		.bind(userId, cutoff)
		.all();
	return (res.results as Record<string, unknown>[]).map(rowToMemory);
}

export async function getUnembeddedMemories(userId: string, env: Env): Promise<Memory[]> {
	const res = await env.DB.prepare(
		"SELECT * FROM memories WHERE userId=? AND embedding_status='pending' LIMIT 100",
	)
		.bind(userId)
		.all();
	return (res.results as Record<string, unknown>[]).map(rowToMemory);
}

// ── People ──

export async function insertPerson(
	userId: string,
	name: string,
	aliases: string[],
	env: Env,
): Promise<Person> {
	const id = uuidv4();
	const now = new Date().toISOString();
	await env.DB.prepare(
		"INSERT INTO people (id,userId,name,aliases,created_at,updated_at) VALUES (?,?,?,?,?,?)",
	)
		.bind(id, userId, name, JSON.stringify(aliases), now, now)
		.run();
	return { id, userId, name, aliases, created_at: now, updated_at: now };
}

export async function listPeople(userId: string, env: Env): Promise<Person[]> {
	const res = await env.DB.prepare("SELECT * FROM people WHERE userId=? ORDER BY name")
		.bind(userId)
		.all();
	return (res.results as any[]).map((r) => ({
		...r,
		aliases: parseJsonField(r.aliases, []),
	})) as unknown as Person[];
}

export async function getPerson(id: string, userId: string, env: Env): Promise<Person | null> {
	const row = await env.DB.prepare("SELECT * FROM people WHERE id=? AND userId=?")
		.bind(id, userId)
		.first();
	return row
		? ({ ...row, aliases: parseJsonField((row as any).aliases, []) } as unknown as Person)
		: null;
}

// ── Person Profiles ──

export async function getPersonProfiles(
	personId: string,
	userId: string,
	env: Env,
): Promise<PersonProfile[]> {
	const res = await env.DB.prepare("SELECT * FROM person_profiles WHERE personId=? AND userId=?")
		.bind(personId, userId)
		.all();
	return (res.results as any[]).map((r) => ({ ...r, content: parseJsonField(r.content, {}) }));
}

export async function upsertPersonProfile(
	personId: string,
	userId: string,
	section: string,
	content: Record<string, unknown>,
	env: Env,
): Promise<void> {
	const existing = await env.DB.prepare(
		"SELECT id FROM person_profiles WHERE personId=? AND userId=? AND section=?",
	)
		.bind(personId, userId, section)
		.first();
	const now = new Date().toISOString();
	if (existing) {
		await env.DB.prepare("UPDATE person_profiles SET content=?, updated_at=? WHERE id=?")
			.bind(JSON.stringify(content), now, (existing as any).id)
			.run();
	} else {
		await env.DB.prepare(
			"INSERT INTO person_profiles (id,personId,userId,section,content,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
		)
			.bind(uuidv4(), personId, userId, section, JSON.stringify(content), now, now)
			.run();
	}
}

// ── Pending Updates ──

export async function insertPendingUpdate(
	userId: string,
	data: {
		personId?: string;
		update_type: string;
		field: string;
		proposed_value: string;
		confidence?: number;
		source?: string;
	},
	env: Env,
): Promise<string> {
	const id = uuidv4();
	await env.DB.prepare(
		"INSERT INTO pending_updates (id,userId,personId,update_type,field,proposed_value,confidence,source,status) VALUES (?,?,?,?,?,?,?,?,?)",
	)
		.bind(
			id,
			userId,
			data.personId ?? null,
			data.update_type,
			data.field,
			data.proposed_value,
			data.confidence ?? 0.5,
			data.source ?? null,
			"pending",
		)
		.run();
	return id;
}

export async function listPendingUpdates(
	userId: string,
	env: Env,
	status = "pending",
): Promise<PendingUpdate[]> {
	const res = await env.DB.prepare(
		"SELECT * FROM pending_updates WHERE userId=? AND status=? ORDER BY created_at DESC",
	)
		.bind(userId, status)
		.all();
	return res.results as unknown as PendingUpdate[];
}

export async function setPendingUpdateStatus(
	id: string,
	userId: string,
	status: string,
	env: Env,
): Promise<void> {
	await env.DB.prepare("UPDATE pending_updates SET status=? WHERE id=? AND userId=?")
		.bind(status, id, userId)
		.run();
}

// ── Session Logs ──

export async function insertSessionLog(
	userId: string,
	sessionId: string,
	entryType: string,
	content: string,
	env: Env,
): Promise<string> {
	const id = uuidv4();
	await env.DB.prepare(
		"INSERT INTO session_logs (id,userId,session_id,entry_type,content) VALUES (?,?,?,?,?)",
	)
		.bind(id, userId, sessionId, entryType, content)
		.run();
	return id;
}

export async function getSessionLogs(
	userId: string,
	sessionId: string,
	env: Env,
): Promise<SessionLog[]> {
	const res = await env.DB.prepare(
		"SELECT * FROM session_logs WHERE userId=? AND session_id=? ORDER BY created_at ASC",
	)
		.bind(userId, sessionId)
		.all();
	return res.results as unknown as SessionLog[];
}

export async function getRecentSessions(
	userId: string,
	env: Env,
	limit = 5,
): Promise<{ session_id: string; entries: number; last_entry: string }[]> {
	const res = await env.DB.prepare(
		"SELECT session_id, COUNT(*) as entries, MAX(created_at) as last_entry FROM session_logs WHERE userId=? GROUP BY session_id ORDER BY last_entry DESC LIMIT ?",
	)
		.bind(userId, limit)
		.all();
	return res.results as any[];
}

// ── Uncertainties ──

export async function insertUncertainty(
	userId: string,
	question: string,
	context: string | null,
	env: Env,
): Promise<string> {
	const id = uuidv4();
	await env.DB.prepare(
		"INSERT INTO uncertainties (id,userId,question,context,status) VALUES (?,?,?,?,?)",
	)
		.bind(id, userId, question, context, "open")
		.run();
	return id;
}

export async function listUncertainties(
	userId: string,
	env: Env,
	status = "open",
): Promise<Uncertainty[]> {
	const res = await env.DB.prepare(
		"SELECT * FROM uncertainties WHERE userId=? AND status=? ORDER BY created_at DESC",
	)
		.bind(userId, status)
		.all();
	return res.results as unknown as Uncertainty[];
}

export async function answerUncertainty(
	id: string,
	userId: string,
	answer: string,
	env: Env,
): Promise<void> {
	await env.DB.prepare(
		"UPDATE uncertainties SET status='answered', answer=?, answered_at=? WHERE id=? AND userId=?",
	)
		.bind(answer, new Date().toISOString(), id, userId)
		.run();
}

// ── AI Notes ──

export async function upsertAiNote(
	userId: string,
	agentId: string,
	key: string,
	content: string,
	env: Env,
	namespace = "default",
): Promise<string> {
	const existing = await env.DB.prepare(
		"SELECT id FROM ai_notes WHERE userId=? AND agent_id=? AND key=? AND namespace=?",
	)
		.bind(userId, agentId, key, namespace)
		.first();
	const now = new Date().toISOString();
	if (existing) {
		await env.DB.prepare("UPDATE ai_notes SET content=?, updated_at=? WHERE id=?")
			.bind(content, now, (existing as any).id)
			.run();
		return (existing as any).id;
	}
	const id = uuidv4();
	await env.DB.prepare(
		"INSERT INTO ai_notes (id,userId,agent_id,namespace,key,content,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
	)
		.bind(id, userId, agentId, namespace, key, content, now, now)
		.run();
	return id;
}

export async function listAiNotes(userId: string, env: Env, agentId?: string): Promise<AiNote[]> {
	let sql = "SELECT * FROM ai_notes WHERE userId=?";
	const params: unknown[] = [userId];
	if (agentId) {
		sql += " AND agent_id=?";
		params.push(agentId);
	}
	sql += " ORDER BY updated_at DESC";
	const res = await env.DB.prepare(sql)
		.bind(...params)
		.all();
	return res.results as unknown as AiNote[];
}

export async function getAiNote(
	userId: string,
	agentId: string,
	key: string,
	env: Env,
	namespace = "default",
): Promise<AiNote | null> {
	return (await env.DB.prepare(
		"SELECT * FROM ai_notes WHERE userId=? AND agent_id=? AND key=? AND namespace=?",
	)
		.bind(userId, agentId, key, namespace)
		.first()) as unknown as AiNote | null;
}

export async function listAiAgents(userId: string, env: Env): Promise<string[]> {
	const res = await env.DB.prepare(
		"SELECT DISTINCT agent_id FROM ai_notes WHERE userId=? ORDER BY agent_id",
	)
		.bind(userId)
		.all();
	return (res.results as any[]).map((r) => r.agent_id);
}

// ── Transcripts ──

export async function insertTranscript(
	userId: string,
	source: string,
	content: string,
	env: Env,
): Promise<string> {
	const id = uuidv4();
	await env.DB.prepare("INSERT INTO transcripts (id,userId,source,content) VALUES (?,?,?,?)")
		.bind(id, userId, source, content)
		.run();
	return id;
}

export async function listTranscripts(userId: string, env: Env): Promise<Transcript[]> {
	const res = await env.DB.prepare(
		"SELECT * FROM transcripts WHERE userId=? ORDER BY created_at DESC",
	)
		.bind(userId)
		.all();
	return (res.results as any[]).map((r) => ({ ...r, processed: Boolean(r.processed) }));
}

export async function markTranscriptProcessed(
	id: string,
	userId: string,
	extractedCount: number,
	env: Env,
): Promise<void> {
	await env.DB.prepare(
		"UPDATE transcripts SET processed=1, extracted_count=? WHERE id=? AND userId=?",
	)
		.bind(extractedCount, id, userId)
		.run();
}

// ── Behavioral ──

export async function insertBehavioralObservation(
	userId: string,
	type: string,
	content: string,
	context: string | null,
	env: Env,
): Promise<string> {
	const id = uuidv4();
	await env.DB.prepare(
		"INSERT INTO behavioral_observations (id,userId,observation_type,content,context) VALUES (?,?,?,?,?)",
	)
		.bind(id, userId, type, content, context)
		.run();
	return id;
}

export async function getBehavioralObservations(
	userId: string,
	env: Env,
	type?: string,
	limit = 50,
): Promise<BehavioralObservation[]> {
	let sql = "SELECT * FROM behavioral_observations WHERE userId=?";
	const params: unknown[] = [userId];
	if (type) {
		sql += " AND observation_type=?";
		params.push(type);
	}
	sql += " ORDER BY created_at DESC LIMIT ?";
	params.push(limit);
	const res = await env.DB.prepare(sql)
		.bind(...params)
		.all();
	return res.results as unknown as BehavioralObservation[];
}

// ── Personality Feedback ──

export async function insertPersonalityFeedback(
	userId: string,
	data: {
		persona?: string;
		tone?: string;
		mode?: string;
		situation?: string;
		outcome?: string;
		feedback_score?: number;
	},
	env: Env,
): Promise<string> {
	const id = uuidv4();
	await env.DB.prepare(
		"INSERT INTO personality_feedback (id,userId,persona,tone,mode,situation,outcome,feedback_score) VALUES (?,?,?,?,?,?,?,?)",
	)
		.bind(
			id,
			userId,
			data.persona ?? "default",
			data.tone ?? null,
			data.mode ?? null,
			data.situation ?? null,
			data.outcome ?? null,
			data.feedback_score ?? null,
		)
		.run();
	return id;
}

export async function getPersonalityFeedback(
	userId: string,
	env: Env,
	persona?: string,
	limit = 50,
): Promise<PersonalityFeedback[]> {
	let sql = "SELECT * FROM personality_feedback WHERE userId=?";
	const params: unknown[] = [userId];
	if (persona) {
		sql += " AND persona=?";
		params.push(persona);
	}
	sql += " ORDER BY created_at DESC LIMIT ?";
	params.push(limit);
	const res = await env.DB.prepare(sql)
		.bind(...params)
		.all();
	return res.results as unknown as PersonalityFeedback[];
}

// ── Write Activity ──

export async function getWriteActivity(
	userId: string,
	env: Env,
	sinceMinutes = 60,
): Promise<{ memories: number; people: number; notes: number }> {
	const since = new Date(Date.now() - sinceMinutes * 60000).toISOString();
	const m = (await env.DB.prepare(
		"SELECT COUNT(*) as c FROM memories WHERE userId=? AND created_at>=?",
	)
		.bind(userId, since)
		.first()) as any;
	const p = (await env.DB.prepare(
		"SELECT COUNT(*) as c FROM people WHERE userId=? AND created_at>=?",
	)
		.bind(userId, since)
		.first()) as any;
	const n = (await env.DB.prepare(
		"SELECT COUNT(*) as c FROM ai_notes WHERE userId=? AND created_at>=?",
	)
		.bind(userId, since)
		.first()) as any;
	return { memories: m?.c ?? 0, people: p?.c ?? 0, notes: n?.c ?? 0 };
}

// ── Extended People Operations ──

export async function searchPeopleByName(
	userId: string,
	query: string,
	env: Env,
): Promise<Person[]> {
	const res = await env.DB.prepare(
		"SELECT * FROM people WHERE userId=? AND (name LIKE ? OR aliases LIKE ?) ORDER BY name",
	)
		.bind(userId, `%${query}%`, `%${query}%`)
		.all();
	return (res.results as any[]).map((r) => ({
		...r,
		aliases: parseJsonField(r.aliases, []),
	})) as unknown as Person[];
}

export async function deletePerson(id: string, userId: string, env: Env): Promise<void> {
	await env.DB.prepare("DELETE FROM person_profiles WHERE personId=? AND userId=?")
		.bind(id, userId)
		.run();
	await env.DB.prepare("DELETE FROM people WHERE id=? AND userId=?").bind(id, userId).run();
}

export async function updatePerson(
	id: string,
	userId: string,
	updates: { name?: string; aliases?: string[] },
	env: Env,
): Promise<void> {
	const sets: string[] = [];
	const vals: unknown[] = [];
	if (updates.name !== undefined) {
		sets.push("name=?");
		vals.push(updates.name);
	}
	if (updates.aliases !== undefined) {
		sets.push("aliases=?");
		vals.push(JSON.stringify(updates.aliases));
	}
	if (sets.length === 0) return;
	sets.push("updated_at=?");
	vals.push(new Date().toISOString());
	vals.push(id, userId);
	await env.DB.prepare(`UPDATE people SET ${sets.join(",")} WHERE id=? AND userId=?`)
		.bind(...vals)
		.run();
}

// ── Extended Memory Queries ──

export async function queryMemoriesByTags(
	userId: string,
	tags: string[],
	env: Env,
	limit = 50,
): Promise<Memory[]> {
	const conditions = tags.map(() => "tags LIKE ?").join(" OR ");
	const params: unknown[] = [userId, ...tags.map((t) => `%"${t}"%`)];
	const res = await env.DB.prepare(
		`SELECT * FROM memories WHERE userId=? AND suppressed=0 AND (${conditions}) ORDER BY created_at DESC LIMIT ?`,
	)
		.bind(...params, limit)
		.all();
	return (res.results as Record<string, unknown>[]).map(rowToMemory);
}

export async function getSuppressedMemories(
	userId: string,
	env: Env,
	limit = 50,
): Promise<Memory[]> {
	const res = await env.DB.prepare(
		"SELECT * FROM memories WHERE userId=? AND suppressed=1 ORDER BY updated_at DESC LIMIT ?",
	)
		.bind(userId, limit)
		.all();
	return (res.results as Record<string, unknown>[]).map(rowToMemory);
}

export async function touchMemoryAccess(id: string, userId: string, env: Env): Promise<void> {
	const now = new Date().toISOString();
	await env.DB.prepare(
		"UPDATE memories SET last_accessed=?, access_count=COALESCE(access_count,0)+1 WHERE id=? AND userId=?",
	)
		.bind(now, id, userId)
		.run();
}

export async function touchMemoryAccessBatch(ids: string[], userId: string, env: Env): Promise<void> {
	if (ids.length === 0) return;
	const batch = ids.slice(0, 25);
	await Promise.all(batch.map((id) => touchMemoryAccess(id, userId, env)));
}

export async function fulltextSearchMemories(
	userId: string,
	query: string,
	env: Env,
	limit = 25,
): Promise<Memory[]> {
	const tokens = query
		.toLowerCase()
		.split(/[^a-z0-9_]+/)
		.filter((t) => t.length > 2)
		.slice(0, 6);
	if (tokens.length === 0) {
		const res = await env.DB.prepare(
			"SELECT * FROM memories WHERE userId=? AND suppressed=0 AND text LIKE ? ORDER BY salience DESC LIMIT ?",
		)
			.bind(userId, `%${query}%`, limit)
			.all();
		return (res.results as Record<string, unknown>[]).map(rowToMemory);
	}

	const conditions = tokens
		.map(() => "(LOWER(text) LIKE ? OR LOWER(COALESCE(subject,'')) LIKE ? OR LOWER(tags) LIKE ?)")
		.join(" OR ");
	const params: unknown[] = [userId];
	for (const t of tokens) {
		const p = `%${t}%`;
		params.push(p, p, p);
	}
	params.push(limit);
	const res = await env.DB.prepare(
		`SELECT * FROM memories WHERE userId=? AND suppressed=0 AND (${conditions}) ORDER BY salience DESC, confidence DESC LIMIT ?`,
	)
		.bind(...params)
		.all();
	return (res.results as Record<string, unknown>[]).map(rowToMemory);
}

export async function getPinnedMemories(userId: string, env: Env, limit = 50): Promise<Memory[]> {
	const res = await env.DB.prepare(
		"SELECT * FROM memories WHERE userId=? AND suppressed=0 AND pinned=1 ORDER BY salience DESC, updated_at DESC LIMIT ?",
	)
		.bind(userId, limit)
		.all();
	return (res.results as Record<string, unknown>[]).map(rowToMemory);
}

export async function getHighSalienceMemories(
	userId: string,
	env: Env,
	minSalience = 0.7,
	limit = 25,
): Promise<Memory[]> {
	const res = await env.DB.prepare(
		"SELECT * FROM memories WHERE userId=? AND suppressed=0 AND salience>=? ORDER BY salience DESC, confidence DESC LIMIT ?",
	)
		.bind(userId, minSalience, limit)
		.all();
	return (res.results as Record<string, unknown>[]).map(rowToMemory);
}

export async function memoryExistsByText(
	userId: string,
	text: string,
	env: Env,
): Promise<Memory | null> {
	const row = await env.DB.prepare(
		"SELECT * FROM memories WHERE userId=? AND suppressed=0 AND text=? LIMIT 1",
	)
		.bind(userId, text)
		.first();
	return row ? rowToMemory(row as Record<string, unknown>) : null;
}

// ── Extended Uncertainty Operations ──

export async function dismissUncertainty(id: string, userId: string, env: Env): Promise<void> {
	await env.DB.prepare("UPDATE uncertainties SET status='dismissed' WHERE id=? AND userId=?")
		.bind(id, userId)
		.run();
}

// ── Extended AI Note Operations ──

export async function deleteAiNote(
	userId: string,
	agentId: string,
	key: string,
	env: Env,
	namespace = "default",
): Promise<void> {
	await env.DB.prepare(
		"DELETE FROM ai_notes WHERE userId=? AND agent_id=? AND key=? AND namespace=?",
	)
		.bind(userId, agentId, key, namespace)
		.run();
}

export async function insertAgentRun(
	userId: string,
	role: string,
	input: string,
	output: string,
	memoryIds: string[],
	env: Env,
): Promise<string> {
	const id = uuidv4();
	await env.DB.prepare(
		"INSERT INTO agent_runs (id,userId,role,input,output,memory_ids) VALUES (?,?,?,?,?,?)",
	)
		.bind(id, userId, role, input, output, JSON.stringify(memoryIds || []))
		.run();
	return id;
}

