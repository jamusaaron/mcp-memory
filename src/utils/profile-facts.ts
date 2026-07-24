import { v4 as uuidv4 } from "uuid";
import {
	SELF_PROFILE_SECTIONS,
	type ProfileFact,
	type SelfProfileSection,
} from "../types";
import { canonicalJson, containsHardSecret, sha256Hex } from "./artifact-synthesis";

const MAX_ACTIVE_PROFILE_FACTS = 50;
const MAX_PROFILE_FIELD_CHARS = 80;
const MAX_PROFILE_VALUE_CHARS = 2_000;
const MAX_PROFILE_VALUE_BYTES = 8_000;
const PROFILE_FIELD_PATTERN = /^[A-Za-z0-9_.-]{1,80}$/;
const RESERVED_PROFILE_FIELDS = new Set([
	"__proto__",
	"prototype",
	"constructor",
]);
const SELF_PROFILE_SECTION_SET = new Set<string>(SELF_PROFILE_SECTIONS);

export type ConfirmedProfileFactInput = {
	section: SelfProfileSection;
	field: string;
	value: string;
	sourceId?: string;
	verifiedAt?: string;
};

function rowToProfileFact(row: Record<string, unknown>): ProfileFact {
	return {
		id: String(row.id),
		userId: String(row.userId),
		section: row.section as SelfProfileSection,
		field: String(row.field),
		value: row.value === null ? null : String(row.value),
		confidence: Number(row.confidence),
		source_type: row.source_type as ProfileFact["source_type"],
		source_id: row.source_id === null ? null : String(row.source_id),
		status: row.status as ProfileFact["status"],
		supersedes_id: row.supersedes_id === null ? null : String(row.supersedes_id),
		verified_at: String(row.verified_at),
		created_at: String(row.created_at),
		updated_at: String(row.updated_at),
	};
}

function boundedFactLimit(limit: number): number {
	if (!Number.isFinite(limit)) return MAX_ACTIVE_PROFILE_FACTS;
	return Math.min(MAX_ACTIVE_PROFILE_FACTS, Math.max(1, Math.trunc(limit)));
}

function validateProfileFactWrite(
	fieldInput: string,
	valueInput: string,
): { field: string; value: string } {
	const field = fieldInput.trim();
	const value = valueInput.trim();
	if (!PROFILE_FIELD_PATTERN.test(field) || RESERVED_PROFILE_FIELDS.has(field)) {
		throw new Error(
			`field must be a safe identifier between 1 and ${MAX_PROFILE_FIELD_CHARS} characters`,
		);
	}
	if (
		!value ||
		value.length > MAX_PROFILE_VALUE_CHARS ||
		/[\u0000\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
	) {
		throw new Error(
			`value must be plain text between 1 and ${MAX_PROFILE_VALUE_CHARS} characters`,
		);
	}
	if (containsHardSecret(value)) {
		throw new Error("value contains secret-shaped content and cannot be stored");
	}
	return { field, value };
}

export async function listActiveProfileFacts(
	userId: string,
	env: Env,
	limit = MAX_ACTIVE_PROFILE_FACTS,
	maxValueBytes = MAX_PROFILE_VALUE_BYTES,
): Promise<ProfileFact[]> {
	const result = await env.DB.prepare(
		`SELECT id,userId,section,field,value,confidence,source_type,source_id,
		        status,supersedes_id,verified_at,created_at,updated_at
		 FROM profile_facts
		 WHERE userId=? AND status='active'
		   AND length(CAST(COALESCE(value,'') AS BLOB))<=?
		 ORDER BY verified_at DESC, section ASC, field ASC, id ASC
		 LIMIT ?`,
	)
		.bind(
			userId,
			Math.min(MAX_PROFILE_VALUE_BYTES, Math.max(1, Math.trunc(maxValueBytes))),
			boundedFactLimit(limit),
		)
		.all();
	return (result.results as Record<string, unknown>[]).map(rowToProfileFact);
}

export async function countActiveProfileFacts(
	userId: string,
	env: Env,
	maxValueBytes = MAX_PROFILE_VALUE_BYTES,
): Promise<number> {
	const row = await env.DB.prepare(
		`SELECT COUNT(*) AS count
		 FROM profile_facts
		 WHERE userId=? AND status='active'
		   AND length(CAST(COALESCE(value,'') AS BLOB))<=?`,
	)
		.bind(
			userId,
			Math.min(MAX_PROFILE_VALUE_BYTES, Math.max(1, Math.trunc(maxValueBytes))),
		)
		.first<{ count: number }>();
	return Number(row?.count ?? 0);
}

export async function setConfirmedProfileFact(
	userId: string,
	input: ConfirmedProfileFactInput,
	env: Env,
): Promise<ProfileFact> {
	if (!SELF_PROFILE_SECTION_SET.has(input.section)) {
		throw new Error("unsupported self-profile section");
	}
	const { field, value } = validateProfileFactWrite(input.field, input.value);

	const current = (await env.DB.prepare(
		`SELECT * FROM profile_facts
		 WHERE userId=? AND section=? AND field=? AND status='active'`,
	)
		.bind(userId, input.section, field)
		.first()) as Record<string, unknown> | null;
	const now = input.verifiedAt ?? new Date().toISOString();
	const id = uuidv4();

	const statements: D1PreparedStatement[] = [];
	if (current) {
		statements.push(
			env.DB.prepare(
				`UPDATE profile_facts
				 SET status='superseded', updated_at=?
				 WHERE id=? AND userId=? AND status='active'`,
			).bind(now, String(current.id), userId),
		);
	}
	statements.push(
		env.DB.prepare(
			`INSERT INTO profile_facts
			 (id,userId,section,field,value,confidence,source_type,source_id,
			  status,supersedes_id,verified_at,created_at,updated_at)
			 VALUES (?,?,?,?,?,1.0,?,?, 'active',?,?,?,?)`,
		).bind(
			id,
			userId,
			input.section,
			field,
			value,
			"stated",
			input.sourceId ?? null,
			current ? String(current.id) : null,
			now,
			now,
			now,
		),
	);
	await env.DB.batch(statements);

	const created = await env.DB.prepare(
		"SELECT * FROM profile_facts WHERE id=? AND userId=?",
	)
		.bind(id, userId)
		.first();
	if (!created) throw new Error("Profile fact write did not produce a row");
	return rowToProfileFact(created as Record<string, unknown>);
}

export function mergeProfileFacts(
	facts: ProfileFact[],
): Record<string, Record<string, string>> {
	const merged: Record<string, Record<string, string>> = {};
	for (const fact of facts) {
		if (fact.status !== "active" || fact.value === null) continue;
		if (
			!PROFILE_FIELD_PATTERN.test(fact.field) ||
			RESERVED_PROFILE_FIELDS.has(fact.field)
		)
			continue;
		merged[fact.section] ??= {};
		merged[fact.section]![fact.field] = fact.value;
	}
	return merged;
}

function legacyValue(value: unknown): string {
	return typeof value === "string" ? value : canonicalJson(value);
}

export async function ensureLegacySelfProfileFacts(
	userId: string,
	env: Env,
): Promise<{ imported: number; skipped: number }> {
	const result = await env.DB.prepare(
		`SELECT id,section,content,updated_at
		 FROM person_profiles
		 WHERE userId=? AND personId='self'
		 ORDER BY updated_at DESC, id DESC`,
	)
		.bind(userId)
		.all();
	let imported = 0;
	let skipped = 0;

	for (const row of result.results as Array<Record<string, unknown>>) {
		let content: Record<string, unknown>;
		try {
			const parsed = JSON.parse(String(row.content));
			content =
				parsed && typeof parsed === "object" && !Array.isArray(parsed)
					? (parsed as Record<string, unknown>)
					: {};
		} catch {
			content = {};
		}
		const entries = Object.entries(content).sort(([a], [b]) => a.localeCompare(b));
		const section = String(row.section);
		if (!SELF_PROFILE_SECTION_SET.has(section)) {
			skipped += entries.length;
			continue;
		}
		for (const [field, rawValue] of entries) {
			const existing = await env.DB.prepare(
				`SELECT id FROM profile_facts
				 WHERE userId=? AND section=? AND field=? AND status='active'`,
			)
				.bind(userId, String(row.section), field)
				.first();
			if (existing) {
				skipped += 1;
				continue;
			}
			const sourceId = `legacy:${String(row.id)}`;
			const deterministicId = `legacy-${await sha256Hex(
				`${userId}\u0000${row.section}\u0000${field}\u0000${sourceId}`,
			)}`;
			let value: string;
			try {
				({ value } = validateProfileFactWrite(field, legacyValue(rawValue)));
			} catch {
				skipped += 1;
				continue;
			}
			const write = await env.DB.prepare(
				`INSERT OR IGNORE INTO profile_facts
				 (id,userId,section,field,value,confidence,source_type,source_id,
				  status,supersedes_id,verified_at,created_at,updated_at)
				 VALUES (?,?,?,?,?,1.0,'stated',?,'active',NULL,?,?,?)`,
			)
				.bind(
					deterministicId,
					userId,
					section,
					field,
					value,
					sourceId,
					String(row.updated_at),
					String(row.updated_at),
					String(row.updated_at),
				)
				.run();
			if (Number(write.meta.changes ?? 0) > 0) imported += 1;
			else skipped += 1;
		}
	}
	return { imported, skipped };
}

export async function tombstoneProfileFact(
	userId: string,
	factId: string,
	_actor: string,
	env: Env,
): Promise<void> {
	const result = await env.DB.prepare(
		`UPDATE profile_facts
		 SET status='tombstoned',value=NULL,updated_at=?
		 WHERE id=? AND userId=? AND status='active'`,
	)
		.bind(new Date().toISOString(), factId, userId)
		.run();
	if (result.meta.changes === 0) {
		throw new Error("Profile fact not found");
	}
}
