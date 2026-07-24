import assert from "node:assert/strict";
import test from "node:test";

import {
	countActiveProfileFacts,
	ensureLegacySelfProfileFacts,
	listActiveProfileFacts,
	mergeProfileFacts,
	setConfirmedProfileFact,
	tombstoneProfileFact,
} from "../src/utils/profile-facts";
import type { ProfileFact } from "../src/types";
import { createSqliteD1Harness, initializeSqliteD1 } from "./helpers/sqlite-d1";

function fact(overrides: Partial<ProfileFact>): ProfileFact {
	return {
		id: "fact-1",
		userId: "u1",
		section: "identity",
		field: "occupation",
		value: "Policy adviser",
		confidence: 1,
		source_type: "stated",
		source_id: null,
		status: "active",
		supersedes_id: null,
		verified_at: "2026-07-24T00:00:00.000Z",
		created_at: "2026-07-24T00:00:00.000Z",
		updated_at: "2026-07-24T00:00:00.000Z",
		...overrides,
	};
}

test("mergeProfileFacts preserves unrelated fields and ignores inactive history", () => {
	const merged = mergeProfileFacts([
		fact({ id: "old", value: "Old role", status: "superseded" }),
		fact({ id: "role", value: "Policy adviser" }),
		fact({
			id: "style",
			section: "personality",
			field: "communication_style",
			value: "Direct",
		}),
	]);

	assert.deepEqual(merged, {
		identity: { occupation: "Policy adviser" },
		personality: { communication_style: "Direct" },
	});
});

test("setConfirmedProfileFact supersedes only the matching field", async () => {
	const harness = createSqliteD1Harness();
	try {
		await initializeSqliteD1(harness.env);
		await setConfirmedProfileFact(
			"u1",
			{ section: "identity", field: "occupation", value: "Policy adviser" },
			harness.env,
		);
		await setConfirmedProfileFact(
			"u1",
			{ section: "identity", field: "hobby", value: "Photography" },
			harness.env,
		);
		const replacement = await setConfirmedProfileFact(
			"u1",
			{ section: "identity", field: "occupation", value: "Researcher" },
			harness.env,
		);

		assert.equal(replacement.value, "Researcher");
		assert.equal(replacement.confidence, 1);
		assert.equal(replacement.source_type, "stated");
		assert.equal(
			harness.db.prepare(
				`SELECT COUNT(*) AS count FROM profile_facts
				 WHERE userId='u1' AND section='identity'
				   AND field='occupation' AND status='active'`,
			).get().count,
			1,
		);
		assert.equal(
			harness.db.prepare(
				`SELECT value FROM profile_facts
				 WHERE userId='u1' AND field='hobby' AND status='active'`,
			).get().value,
			"Photography",
		);
		assert.equal(await countActiveProfileFacts("u1", harness.env), 2);
		assert.equal((await listActiveProfileFacts("u1", harness.env, 1)).length, 1);
		assert.equal(await countActiveProfileFacts("u1", harness.env, 4_096), 2);
	} finally {
		harness.close();
	}
});

test("legacy self rows import once without overwriting newer canonical facts", async () => {
	const harness = createSqliteD1Harness();
	try {
		await initializeSqliteD1(harness.env);
		await setConfirmedProfileFact(
			"u1",
			{ section: "identity", field: "occupation", value: "Current role" },
			harness.env,
		);
		harness.db.prepare(
			"INSERT INTO people (id,userId,name) VALUES ('self','u1','Self')",
		).run();
		harness.db.prepare(
			`INSERT INTO person_profiles
			 (id,personId,userId,section,content,created_at,updated_at)
			 VALUES ('legacy-old','self','u1','identity',
			 '{"occupation":"Old role","location":"Sydney"}',
			 '2026-07-01T00:00:00.000Z','2026-07-01T00:00:00.000Z')`,
		).run();
		harness.db.prepare(
			`INSERT INTO person_profiles
			 (id,personId,userId,section,content,created_at,updated_at)
			 VALUES ('legacy-new','self','u1','identity',
			 '{"occupation":"Newer old role","location":"Melbourne"}',
			 '2026-07-02T00:00:00.000Z','2026-07-02T00:00:00.000Z')`,
		).run();

		assert.deepEqual(await ensureLegacySelfProfileFacts("u1", harness.env), {
			imported: 1,
			skipped: 3,
		});
		assert.deepEqual(await ensureLegacySelfProfileFacts("u1", harness.env), {
			imported: 0,
			skipped: 4,
		});
		const imported = harness.db.prepare(
			`SELECT value,source_type,source_id FROM profile_facts
			 WHERE userId='u1' AND field='location' AND status='active'`,
		).get();
		assert.deepEqual({ ...imported }, {
			value: "Melbourne",
			source_type: "stated",
			source_id: "legacy:legacy-new",
		});
	} finally {
		harness.close();
	}
});

test("profile fact tombstone is tenant scoped and clears content", async () => {
	const harness = createSqliteD1Harness();
	try {
		await initializeSqliteD1(harness.env);
		const created = await setConfirmedProfileFact(
			"u1",
			{ section: "identity", field: "location", value: "Melbourne" },
			harness.env,
		);
		await assert.rejects(
			tombstoneProfileFact("u2", created.id, "user", harness.env),
			/Profile fact not found/,
		);
		await tombstoneProfileFact("u1", created.id, "user", harness.env);
		assert.deepEqual(
			{
				...harness.db
					.prepare("SELECT status,value FROM profile_facts WHERE id=?")
					.get(created.id),
			},
			{ status: "tombstoned", value: null },
		);
	} finally {
		harness.close();
	}
});

test("profile fact writes reject secret-shaped and oversized values", async () => {
	const harness = createSqliteD1Harness();
	try {
		await initializeSqliteD1(harness.env);
		await assert.rejects(
			setConfirmedProfileFact(
				"u1",
				{
					section: "identity",
					field: "api_key",
					value: "sk-proj-abcdefghijklmnopqrstuvwxyz123456",
				},
				harness.env,
			),
			/secret-shaped content/,
		);
		await assert.rejects(
			setConfirmedProfileFact(
				"u1",
				{ section: "identity", field: "x".repeat(121), value: "safe" },
				harness.env,
			),
			/field must be a safe identifier/,
		);
		await assert.rejects(
			setConfirmedProfileFact(
				"u1",
				{ section: "identity", field: "bio", value: "x".repeat(2_001) },
				harness.env,
			),
			/value must be plain text/,
		);
		for (const field of ["__proto__", "prototype", "constructor"]) {
			await assert.rejects(
				setConfirmedProfileFact(
					"u1",
					{ section: "identity", field, value: "unsafe key" },
					harness.env,
				),
				/field must be a safe identifier/,
			);
		}
		const merged = mergeProfileFacts([
			fact({ id: "pollution", field: "__proto__", value: "polluted" }),
		]);
		assert.deepEqual(merged, {});
		assert.equal(
			(Object.prototype as Record<string, unknown>).polluted,
			undefined,
		);
	} finally {
		harness.close();
	}
});
