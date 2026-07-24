export type DatabaseMigrationStatus = {
	ready: boolean;
	ledgerExists: boolean;
	appliedVersions: number[];
	nextVersion: number | null;
	queryCount: 1 | 2;
};

export type DatabaseInitializationResult = {
	ready: boolean;
	changed: boolean;
	queryCount: number;
};

export type MigrationDefinition = {
	version: number;
	name: string;
	statements: readonly string[];
	requiredColumns?: Readonly<
		Record<
			string,
			Readonly<
				Record<
					string,
					{
						definition: string;
						type: string;
						notNull: boolean;
						defaultValue: string | null;
					}
				>
			>
		>
	>;
};

export const LEDGER_SQL = `CREATE TABLE IF NOT EXISTS schema_migrations (
	version INTEGER PRIMARY KEY,
	name TEXT NOT NULL,
	checksum TEXT NOT NULL,
	applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`;

export const DATABASE_MIGRATIONS: readonly MigrationDefinition[] = [
	{
		version: 1,
		name: "verified_legacy_baseline",
		statements: [],
	},
	{
		version: 2,
		name: "derived_artifact_ledger",
		statements: [
			`CREATE TABLE IF NOT EXISTS derived_artifacts (
				id TEXT PRIMARY KEY,
				userId TEXT NOT NULL,
				kind TEXT NOT NULL CHECK(kind IN ('living_summary','self_profile','behavioral_profile')),
				version INTEGER NOT NULL,
				status TEXT NOT NULL CHECK(status IN ('candidate','published','stale','superseded','rejected','tombstoned')),
				validation_state TEXT NOT NULL CHECK(validation_state IN ('validated','legacy_unverified')),
				content_json TEXT,
				rendered_text TEXT,
				source_watermark TEXT,
				evidence_generation INTEGER NOT NULL DEFAULT 0,
				eligible_source_count INTEGER NOT NULL DEFAULT 0,
				selected_source_count INTEGER NOT NULL DEFAULT 0,
				source_truncated INTEGER NOT NULL DEFAULT 0,
				content_sha256 TEXT,
				model TEXT,
				prompt_version TEXT NOT NULL,
				validation_json TEXT NOT NULL DEFAULT '{}',
				supersedes_id TEXT,
				created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
				published_at TEXT,
				reviewed_at TEXT,
				reviewed_by TEXT,
				UNIQUE(userId,kind,version)
			)`,
			`CREATE UNIQUE INDEX IF NOT EXISTS idx_artifact_active
			 ON derived_artifacts(userId,kind)
			 WHERE status IN ('published','stale')`,
			`CREATE UNIQUE INDEX IF NOT EXISTS idx_artifact_candidate_watermark
			 ON derived_artifacts(userId,kind,source_watermark)
			 WHERE status='candidate'`,
			`CREATE INDEX IF NOT EXISTS idx_artifact_history
			 ON derived_artifacts(userId,kind,status,created_at DESC,id ASC)`,
			`CREATE INDEX IF NOT EXISTS idx_artifact_kind_history
			 ON derived_artifacts(userId,kind,created_at DESC)`,
			`CREATE TABLE IF NOT EXISTS derived_artifact_sources (
				artifact_id TEXT NOT NULL,
				userId TEXT NOT NULL,
				claim_id TEXT NOT NULL,
				source_kind TEXT NOT NULL,
				source_id TEXT NOT NULL,
				source_updated_at TEXT NOT NULL,
				source_sha256 TEXT NOT NULL,
				citation_role TEXT NOT NULL DEFAULT 'supporting',
				PRIMARY KEY(artifact_id,claim_id,source_kind,source_id),
				FOREIGN KEY(artifact_id) REFERENCES derived_artifacts(id)
			)`,
			`CREATE INDEX IF NOT EXISTS idx_artifact_source_lookup
			 ON derived_artifact_sources(userId,source_kind,source_id)`,
			`CREATE TABLE IF NOT EXISTS derived_artifact_events (
				id TEXT PRIMARY KEY,
				userId TEXT NOT NULL,
				artifact_id TEXT,
				kind TEXT NOT NULL,
				event_type TEXT NOT NULL,
				reason_code TEXT,
				actor TEXT NOT NULL,
				source_watermark TEXT,
				metadata_json TEXT NOT NULL DEFAULT '{}',
				created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
			)`,
			`CREATE INDEX IF NOT EXISTS idx_artifact_events
			 ON derived_artifact_events(userId,artifact_id,created_at ASC,id ASC)`,
			`CREATE TABLE IF NOT EXISTS derived_artifact_rebuild_state (
				userId TEXT NOT NULL,
				kind TEXT NOT NULL CHECK(kind='living_summary'),
				retry_count INTEGER NOT NULL DEFAULT 0,
				next_retry_at TEXT,
				last_error_code TEXT,
				operation_id TEXT NOT NULL,
				updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
				PRIMARY KEY(userId,kind)
			)`,
			`CREATE INDEX IF NOT EXISTS idx_artifact_rebuild_due
			 ON derived_artifact_rebuild_state(kind,next_retry_at,userId)`,
			`CREATE TABLE IF NOT EXISTS derived_artifact_evidence_state (
				userId TEXT NOT NULL,
				kind TEXT NOT NULL CHECK(kind IN ('living_summary','self_profile','behavioral_profile')),
				generation INTEGER NOT NULL DEFAULT 0,
				updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
				PRIMARY KEY(userId,kind)
			)`,
			`CREATE TABLE IF NOT EXISTS derived_artifact_legacy_state (
				userId TEXT NOT NULL,
				kind TEXT NOT NULL CHECK(kind IN ('living_summary','self_profile','behavioral_profile')),
				state TEXT NOT NULL CHECK(state IN ('imported','retired')),
				operation_id TEXT NOT NULL,
				legacy_sha256 TEXT,
				imported_at TEXT,
				retired_at TEXT,
				updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
				PRIMARY KEY(userId,kind)
			)`,
			`CREATE TABLE IF NOT EXISTS artifact_cache_purge_queue (
				userId TEXT NOT NULL,
				kind TEXT NOT NULL CHECK(kind IN ('living_summary','self_profile','behavioral_profile')),
				artifact_id TEXT NOT NULL,
				operation_id TEXT NOT NULL,
				attempt_count INTEGER NOT NULL DEFAULT 0,
				next_attempt_at TEXT,
				last_error_code TEXT,
				created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
				updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
				PRIMARY KEY(userId,artifact_id),
				FOREIGN KEY(artifact_id) REFERENCES derived_artifacts(id)
			)`,
			`CREATE INDEX IF NOT EXISTS idx_artifact_cache_purge_due
			 ON artifact_cache_purge_queue(next_attempt_at,userId,artifact_id)`,
			`CREATE INDEX IF NOT EXISTS idx_artifact_cache_purge_tenant_due
			 ON artifact_cache_purge_queue(userId,next_attempt_at,artifact_id)`,
		],
	},
	{
		version: 3,
		name: "canonical_profile_facts",
		statements: [
			`CREATE TABLE IF NOT EXISTS profile_facts (
				id TEXT PRIMARY KEY,
				userId TEXT NOT NULL,
				section TEXT NOT NULL,
				field TEXT NOT NULL,
				value TEXT,
				confidence REAL NOT NULL,
				source_type TEXT NOT NULL,
				source_id TEXT,
				status TEXT NOT NULL CHECK(status IN ('active','superseded','tombstoned')),
				supersedes_id TEXT,
				verified_at TEXT NOT NULL,
				created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
				updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
			)`,
			`CREATE UNIQUE INDEX IF NOT EXISTS idx_profile_fact_active
			 ON profile_facts(userId,section,field)
			 WHERE status='active'`,
			`CREATE INDEX IF NOT EXISTS idx_profile_fact_history
			 ON profile_facts(userId,section,field,created_at DESC,id ASC)`,
		],
	},
	{
		version: 4,
		name: "behavioral_evidence_metadata",
		statements: [],
		requiredColumns: {
			behavioral_observations: {
				source_type: {
					definition: "TEXT NOT NULL DEFAULT 'observed'",
					type: "TEXT",
					notNull: true,
					defaultValue: "'observed'",
				},
				confidence: {
					definition: "REAL NOT NULL DEFAULT 0.5",
					type: "REAL",
					notNull: true,
					defaultValue: "0.5",
				},
				status: {
					definition: "TEXT NOT NULL DEFAULT 'active'",
					type: "TEXT",
					notNull: true,
					defaultValue: "'active'",
				},
				verified_at: {
					definition: "TEXT",
					type: "TEXT",
					notNull: false,
					defaultValue: null,
				},
			},
		},
	},
];

async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

async function migrationChecksum(
	migration: MigrationDefinition,
): Promise<string> {
	return sha256Hex(
		JSON.stringify({
			version: migration.version,
			name: migration.name,
			statements: migration.statements,
			requiredColumns: migration.requiredColumns ?? {},
		}),
	);
}

type ColumnInfo = {
	name: string;
	type: string;
	notnull: number;
	dflt_value: string | null;
};

const MAX_INITIALIZATION_QUERIES = 49;

export type MigrationQueryBudget = {
	readonly used: number;
	run(sql: string, values?: unknown[]): Promise<D1Result<unknown>>;
	first<T>(sql: string, values?: unknown[]): Promise<T | null>;
	all<T>(sql: string, values?: unknown[]): Promise<D1Result<T>>;
	batch(statements: D1PreparedStatement[]): Promise<D1Result<unknown>[]>;
};

export function migrationQueryBudget(env: Env): MigrationQueryBudget {
	let used = 0;
	const reserve = (count: number) => {
		if (used + count > MAX_INITIALIZATION_QUERIES) {
			throw new Error("Database initialization query budget exceeded");
		}
		used += count;
	};
	return {
		get used() {
			return used;
		},
		async run(sql, values = []) {
			reserve(1);
			return env.DB.prepare(sql)
				.bind(...values)
				.run();
		},
		async first<T>(sql: string, values: unknown[] = []) {
			reserve(1);
			return env.DB.prepare(sql)
				.bind(...values)
				.first<T>();
		},
		async all<T>(sql: string, values: unknown[] = []) {
			reserve(1);
			return env.DB.prepare(sql)
				.bind(...values)
				.all<T>();
		},
		async batch(statements) {
			// D1 counts every statement inside batch() against its per-invocation
			// query limit, so reserve the full cardinality before sending it.
			reserve(statements.length);
			return env.DB.batch(statements);
		},
	};
}

async function existingColumnsWithBudget(
	db: MigrationQueryBudget,
	table: string,
): Promise<Map<string, ColumnInfo>> {
	const result = await db.all<ColumnInfo>(`PRAGMA table_info(${table})`);
	return new Map(result.results.map((column) => [column.name, column]));
}

async function assertLegacyBaselineWithBudget(
	db: MigrationQueryBudget,
): Promise<void> {
	const required: Record<string, string[]> = {
		memories: ["id", "userId", "text", "updated_at", "pinned", "access_count"],
		person_profiles: ["id", "personId", "userId", "section", "content"],
		behavioral_observations: ["id", "userId", "observation_type", "content"],
		personality_feedback: ["id", "userId", "feedback_score", "created_at"],
	};
	for (const [table, columns] of Object.entries(required)) {
		const present = await existingColumnsWithBudget(db, table);
		for (const column of columns) {
			if (!present.has(column)) {
				throw new Error(`Legacy baseline missing ${table}.${column}`);
			}
		}
	}
}

export async function appendRequiredColumnStatementsWithBudget(
	db: MigrationQueryBudget,
	env: Env,
	requiredColumns: NonNullable<MigrationDefinition["requiredColumns"]>,
	statements: D1PreparedStatement[],
): Promise<void> {
	for (const [table, columns] of Object.entries(requiredColumns)) {
		const present = await existingColumnsWithBudget(db, table);
		for (const [column, spec] of Object.entries(columns)) {
			if (!present.has(column)) {
				statements.push(
					env.DB.prepare(
						`ALTER TABLE ${table} ADD COLUMN ${column} ${spec.definition}`,
					),
				);
			}
		}
	}
}

export async function readStatusWithBudget(
	db: MigrationQueryBudget,
): Promise<Omit<DatabaseMigrationStatus, "queryCount">> {
	const ledger = await db.first<{ name: string }>(
		`SELECT name FROM sqlite_master
		 WHERE type='table' AND name='schema_migrations'`,
	);
	if (!ledger) {
		return {
			ready: false,
			ledgerExists: false,
			appliedVersions: [],
			nextVersion: DATABASE_MIGRATIONS[0]?.version ?? null,
		};
	}
	const applied = await db.all<{
		version: number;
		name: string;
		checksum: string;
	}>("SELECT version,name,checksum FROM schema_migrations ORDER BY version");
	for (let index = 0; index < applied.results.length; index += 1) {
		const expected = DATABASE_MIGRATIONS[index];
		const actual = applied.results[index];
		if (!expected || actual.version !== expected.version) {
			throw new Error(`Unexpected migration version ${actual.version}`);
		}
		if (actual.name !== expected.name) {
			throw new Error(`Migration ${actual.version} name mismatch`);
		}
		if (actual.checksum !== (await migrationChecksum(expected))) {
			throw new Error(`Migration ${actual.version} checksum mismatch`);
		}
	}
	const next = DATABASE_MIGRATIONS[applied.results.length];
	return {
		ready: next === undefined,
		ledgerExists: true,
		appliedVersions: applied.results.map(({ version }) => version),
		nextVersion: next?.version ?? null,
	};
}

export async function readDatabaseMigrationStatus(
	env: Env,
): Promise<DatabaseMigrationStatus> {
	const db = migrationQueryBudget(env);
	const status = await readStatusWithBudget(db);
	return { ...status, queryCount: db.used as 1 | 2 };
}

export async function advanceDatabaseInitializationWithBudget(
	db: MigrationQueryBudget,
	env: Env,
	status: Omit<DatabaseMigrationStatus, "queryCount">,
): Promise<DatabaseInitializationResult> {
	if (status.ready) {
		return { ready: true, changed: false, queryCount: db.used };
	}
	let current = status;
	if (!current.ledgerExists) {
		await db.run(LEDGER_SQL);
		current = { ...current, ledgerExists: true };
	}
	const migration = DATABASE_MIGRATIONS.find(
		({ version }) => version === current.nextVersion,
	);
	if (!migration) throw new Error("Missing next database migration");
	if (migration.version === 1) {
		await assertLegacyBaselineWithBudget(db);
	}
	const statements = migration.statements.map((sql) => env.DB.prepare(sql));
	await appendRequiredColumnStatementsWithBudget(
		db,
		env,
		migration.requiredColumns ?? {},
		statements,
	);
	const checksum = await migrationChecksum(migration);
	statements.push(
		env.DB.prepare(
			"INSERT INTO schema_migrations(version,name,checksum) VALUES(?,?,?)",
		).bind(migration.version, migration.name, checksum),
	);
	try {
		await db.batch(statements);
	} catch (error) {
		const concurrentWinner = await db.first<{
			name: string;
			checksum: string;
		}>("SELECT name,checksum FROM schema_migrations WHERE version=?", [
			migration.version,
		]);
		if (
			concurrentWinner?.name !== migration.name ||
			concurrentWinner.checksum !== checksum
		) {
			throw error;
		}
	}
	return {
		ready:
			migration.version ===
			DATABASE_MIGRATIONS[DATABASE_MIGRATIONS.length - 1]?.version,
		changed: true,
		queryCount: db.used,
	};
}

export async function advanceDatabaseInitialization(
	env: Env,
): Promise<DatabaseInitializationResult> {
	const db = migrationQueryBudget(env);
	const status = await readStatusWithBudget(db);
	return advanceDatabaseInitializationWithBudget(db, env, status);
}
