import type { DB } from "./db";
import * as dbModule from "./db";

let db: DB | null = null;

export interface Todo {
	id: string;
	text: string;
	completed: boolean;
	created_at: number;
	updated_at: number;
}

export type Scalar =
	| string
	| number
	| boolean
	| null
	| ArrayBuffer
	| ArrayBufferView;

// CR-SQLite change object interface
export interface CRSQLChange {
	table: string;
	pk: string | Uint8Array;
	cid: string;
	val: Scalar;
	col_version: number;
	db_version: number;
	site_id: Uint8Array;
	cl: number;
	seq: number;
}

export const initDatabase = async (): Promise<DB> => {
	if (db) return db;

	try {
		// Open database (web version handles initialization internally)
		db = dbModule.open({
			name: "crsqlite-demo.db",
			location: "default",
		});

		// Create tables with CR-SQLite compatible schema if they don't exist
		// All NOT NULL columns need DEFAULT values for CR-SQLite
		await db.execute(`
      CREATE TABLE IF NOT EXISTS todos (
        id TEXT PRIMARY KEY NOT NULL,
        text TEXT DEFAULT '' NOT NULL,
        completed INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT 0,
        updated_at INTEGER DEFAULT 0
      );
    `);

		// Make table a CRDT
		await db.execute(`SELECT crsql_as_crr('todos');`);

		console.debug("Database initialized with cr-sqlite");
		return db;
	} catch (error) {
		console.error("Failed to initialize database:", error);
		throw error;
	}
};

export const getDatabase = (): DB => {
	if (!db) {
		throw new Error("Database not initialized. Call initDatabase() first.");
	}
	return db;
};

export const getSiteId = async (): Promise<string> => {
	const result = await getDatabase().execute(
		"SELECT crsql_site_id() as site_id",
	);
	return result.rows[0]?.site_id || "unknown";
};

export const getDbVersion = async (): Promise<number> => {
	const result = await getDatabase().execute(
		"SELECT crsql_db_version() as version",
	);
	return result.rows[0]?.version || 0;
};

// Todo CRUD operations
export const addTodo = async (text: string): Promise<string> => {
	const id = `todo_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
	const now = Math.floor(Date.now() / 1000);
	await getDatabase().execute(
		"INSERT INTO todos (id, text, created_at, updated_at) VALUES (?, ?, ?, ?)",
		[id, text, now, now],
	);
	return id;
};

export const getTodos = async (): Promise<Todo[]> => {
	const result = await getDatabase().execute(
		"SELECT * FROM todos ORDER BY created_at DESC",
	);
	return result.rows || [];
};

export const toggleTodo = async (id: string): Promise<void> => {
	const now = Math.floor(Date.now() / 1000);
	await getDatabase().execute(
		`UPDATE todos SET completed = NOT completed, updated_at = ? WHERE id = ?`,
		[now, id],
	);
};

export const deleteTodo = async (id: string): Promise<void> => {
	await getDatabase().execute("DELETE FROM todos WHERE id = ?", [id]);
};

// Sync operations
export const getChanges = async (
	sinceVersion: number = 0,
): Promise<CRSQLChange[]> => {
	const result = await getDatabase().execute(
		`SELECT * FROM crsql_changes WHERE db_version > ?`,
		[sinceVersion],
	);
	return (result.rows || []) as CRSQLChange[];
};

export const applyChanges = async (changes: CRSQLChange[]): Promise<void> => {
	const db = getDatabase();
	await db.transaction(async (tx) => {
		for (const change of changes) {
			await tx.execute(
				`INSERT INTO crsql_changes (
          "table", pk, cid, val, col_version, db_version, site_id, cl, seq
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					change.table,
					change.pk,
					change.cid,
					change.val,
					change.col_version,
					change.db_version,
					change.site_id,
					change.cl,
					change.seq,
				],
			);
		}
	});
};

export const closeDatabase = async (): Promise<void> => {
	if (db) {
		db.close();
		db = null;
	}
};
