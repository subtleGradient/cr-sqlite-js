import initWasm, { type SQLite3 } from "@vlcn.io-community/crsqlite-wasm";
import wasmUrl from "@vlcn.io-community/crsqlite-wasm/crsqlite.wasm";

type SQLite3DB = Awaited<ReturnType<SQLite3["open"]>>;

let sqlite3: Awaited<ReturnType<typeof initWasm>> | null = null;
let initPromise: Promise<void> | null = null;
const dbInstances = new Map<string, Promise<SQLite3DB>>();

// DB interface that matches op-sqlite's interface
export interface DB {
	execute(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
	transaction<T>(fn: (tx: DB) => Promise<T>): Promise<T>;
	close(): void;
}

// For React 19 - Suspense-based DB that can use React.use()
export class SuspenseDB implements DB {
	constructor(private dbPromise: Promise<SQLite3DB>) {}

	// This can be called with React.use() in components
	getDbPromise() {
		return this.dbPromise;
	}

	async execute(sql: string, params?: unknown[]): Promise<{ rows: any[] }> {
		try {
			const db = await this.dbPromise;
			const result = await db.execO(sql, params || []);
			return { rows: result };
		} catch (error) {
			console.error("[db.web] Execute failed:", {
				sql,
				error: error instanceof Error ? error.message : "Unknown error",
			});
			throw new Error(
				`Database operation failed: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}
	}

	async transaction<T>(fn: (tx: DB) => Promise<T>): Promise<T> {
		try {
			const db = await this.dbPromise;
			return await db.tx(async (innerTx) => {
				const txWrapper: DB = {
					execute: async (sql: string, params?: unknown[]) => {
						try {
							const result = await innerTx.execO(sql, params || []);
							return { rows: result };
						} catch (error) {
							console.error("[db.web] Transaction execute failed:", {
								sql,
								error,
							});
							throw error;
						}
					},
					transaction: async (innerFn) => {
						// Nested transactions just execute in the same transaction
						return innerFn(txWrapper);
					},
					close: () => {
						// No-op for transaction
					},
				};
				return fn(txWrapper);
			});
		} catch (error) {
			console.error("[db.web] Transaction failed:", error);
			throw new Error(
				`Database transaction failed: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}
	}

	async close(): Promise<void> {
		try {
			const db = await this.dbPromise;
			db.close();
		} catch (error) {
			console.error("[db.web] Close failed:", error);
			// Don't throw on close errors, just log them
		}
	}
}

export async function ensureInitialized(): Promise<void> {
	if (sqlite3) return;

	if (!initPromise) {
		initPromise = initWasm((file) => {
			// Provide the WASM URL directly, avoiding import.meta
			if (file === "crsqlite.wasm") {
				return wasmUrl;
			}
			return file;
		})
			.then((s) => {
				sqlite3 = s;
				console.debug("SQLite WASM initialized");
			})
			.catch((error) => {
				console.error("[db.web] Failed to initialize SQLite WASM:", error);
				throw new Error(
					`SQLite WASM initialization failed: ${error instanceof Error ? error.message : "Unknown error"}`,
				);
			});
	}

	await initPromise;
}

export function open(options: { name: string; location?: string }): DB {
	// Early return if cached instance exists, error if not found
	{
		const dbPromise = dbInstances.get(options.name);
		if (dbPromise) return new SuspenseDB(dbPromise);
		if (dbInstances.has(options.name))
			throw new Error(`Database "${options.name}" not found in cache`);
	}
	// Create new db promise that includes initialization
	const dbPromise = ensureInitialized()
		.then(() => {
			if (!sqlite3)
				throw new Error("SQLite WASM not available after initialization");

			return sqlite3.open(options.name);
		})
		.catch((error) => {
			console.error("[db.web] Failed to open database:", {
				name: options.name,
				error,
			});
			// Remove from cache if opening failed
			dbInstances.delete(options.name);
			throw new Error(
				`Failed to open database "${options.name}": ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		});

	dbInstances.set(options.name, dbPromise);
	return new SuspenseDB(dbPromise);
}

// Start initialization on module load
if (typeof window !== "undefined") {
	ensureInitialized().catch((error) => {
		console.warn(
			"[db.web] Background initialization failed, will retry on first use:",
			error,
		);
		// Reset promise so it can be retried
		initPromise = null;
	});
}
