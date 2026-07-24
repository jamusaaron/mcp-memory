import { DatabaseSync, type StatementSync } from "node:sqlite";

import { DATABASE_MIGRATIONS } from "../../src/migrations";
import { initializeDatabase } from "../../src/schema";

class SqliteD1Statement {
	constructor(
		private readonly database: DatabaseSync,
		readonly sql: string,
		private readonly values: unknown[],
		private readonly onQuery: () => void,
	) {}

	bind(...values: unknown[]): SqliteD1Statement {
		return new SqliteD1Statement(
			this.database,
			this.sql,
			values,
			this.onQuery,
		);
	}

	private prepared(): StatementSync {
		return this.database.prepare(this.sql);
	}

	async run(): Promise<D1Result<unknown>> {
		this.onQuery();
		const result = this.prepared().run(...(this.values as never[]));
		return {
			success: true,
			meta: { changes: Number(result.changes) },
			results: [],
		} as unknown as D1Result<unknown>;
	}

	async all<T>(): Promise<D1Result<T>> {
		this.onQuery();
		// node:sqlite returns null-prototype rows; D1 returns plain objects, so
		// normalise to keep deep-equality and JSON behaviour identical to D1.
		const rows = this.prepared().all(...(this.values as never[])) as Record<
			string,
			unknown
		>[];
		return {
			success: true,
			meta: {},
			results: rows.map((row) => ({ ...row })) as T[],
		} as unknown as D1Result<T>;
	}

	async first<T>(column?: string): Promise<T | null> {
		this.onQuery();
		const row = this.prepared().get(...(this.values as never[])) as
			| Record<string, unknown>
			| undefined;
		if (!row) return null;
		const plain = { ...row };
		return (column ? plain[column] : plain) as T;
	}
}

export function createSqliteD1(): D1Database & {
	raw: DatabaseSync;
	queryCount(): number;
	resetQueryCount(): void;
	close(): void;
} {
	const database = new DatabaseSync(":memory:");
	let queryCount = 0;
	database.exec("PRAGMA foreign_keys=ON");
	return {
		raw: database,
		prepare(sql: string) {
			return new SqliteD1Statement(
				database,
				sql,
				[],
				() => {
					queryCount += 1;
				},
			) as unknown as D1PreparedStatement;
		},
		async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
			database.exec("BEGIN IMMEDIATE");
			try {
				const results: D1Result<T>[] = [];
				for (const statement of statements) {
					results.push(await statement.run<T>());
				}
				database.exec("COMMIT");
				return results;
			} catch (error) {
				database.exec("ROLLBACK");
				throw error;
			}
		},
		async exec(sql: string) {
			queryCount += sql.split(";").filter((part) => part.trim()).length;
			database.exec(sql);
			return { count: 0, duration: 0 };
		},
		async dump() {
			throw new Error("dump is outside the test adapter contract");
		},
		withSession() {
			throw new Error("sessions are outside the test adapter contract");
		},
		queryCount() {
			return queryCount;
		},
		resetQueryCount() {
			queryCount = 0;
		},
		close() {
			database.close();
		},
	} as unknown as D1Database & {
		raw: DatabaseSync;
		queryCount(): number;
		resetQueryCount(): void;
		close(): void;
	};
}

export type SqliteD1Harness = {
	env: Env;
	db: DatabaseSync;
	kv: Map<string, string>;
	close(): void;
};

export async function initializeSqliteD1(env: Env): Promise<void> {
	for (let attempt = 0; attempt < DATABASE_MIGRATIONS.length + 3; attempt += 1) {
		const result = await initializeDatabase(env);
		if (result.ready && !result.changed) return;
	}
	throw new Error("Database did not reach a stable current schema");
}

export function createSqliteD1Harness(): SqliteD1Harness {
	const DB = createSqliteD1();
	const kv = new Map<string, string>();
	const KV = {
		get: async (key: string) => kv.get(key) ?? null,
		put: async (key: string, value: string) => {
			kv.set(key, value);
		},
		delete: async (key: string) => {
			kv.delete(key);
		},
	} as unknown as KVNamespace;
	return {
		env: { DB, KV } as Env,
		db: DB.raw,
		kv,
		close: () => DB.close(),
	};
}
