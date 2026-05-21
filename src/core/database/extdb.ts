// ── Restricted extension DB ─────────────────────────────────────
// Ported from internal/core/database/extdb.go

import { eq, and, sql } from "drizzle-orm";
import type { DbType } from "./pool.js";
import * as schema from "./schema.js";

export interface ExtPermissions {
	allowedSchemas: string[];
	allowedCoreTables: string[];
	canCreateTables: boolean;
	canModifyCoreTables: boolean;
	maxRowsPerQuery: number;
	readOnly: boolean;
}

export function defaultExtPermissions(name: string): ExtPermissions {
	return {
		allowedSchemas: ["public", `ext_${name}`],
		allowedCoreTables: ["sessions", "events"],
		canCreateTables: true,
		canModifyCoreTables: false,
		maxRowsPerQuery: 10000,
		readOnly: false,
	};
}

const BLOCKED_PATTERNS = [
	/\bDROP\b/i,
	/\bTRUNCATE\b/i,
	/\bGRANT\b/i,
	/\bREVOKE\b/i,
	/\bVACUUM\b/i,
	/\bREINDEX\b/i,
	/\bRENAME\b/i,
];

const WRITE_PATTERN = /\b(INSERT|UPDATE|DELETE|ALTER|CREATE)\b/i;

function validateSql(query: string, perms: ExtPermissions): void {
	const upper = query.toUpperCase();

	for (const pat of BLOCKED_PATTERNS) {
		if (pat.test(upper)) {
			throw new Error(`blocked SQL operation in query`);
		}
	}

	if (WRITE_PATTERN.test(upper) && perms.readOnly) {
		throw new Error(`write operation blocked (read-only extension)`);
	}

	// Check core table writes
	if (WRITE_PATTERN.test(upper) && !perms.canModifyCoreTables) {
		for (const table of perms.allowedCoreTables) {
			if (upper.includes(table.toUpperCase())) {
				throw new Error(`write to core table "${table}" is not allowed`);
			}
		}
	}
}

export class ExtDB {
	private db: DbType;
	private extName: string;
	private perms: ExtPermissions;

	constructor(db: DbType, name: string, perms?: ExtPermissions) {
		this.db = db;
		this.extName = name;
		this.perms = perms ?? defaultExtPermissions(name);
	}

	get name(): string {
		return this.extName;
	}

	get permissions(): ExtPermissions {
		return this.perms;
	}

	/** Execute a raw SQL string (validated against permissions). */
	async query(querySql: string, ..._args: unknown[]) {
		validateSql(querySql, this.perms);
		return this.db.execute(sql.raw(querySql));
	}

	/** Execute a drizzle SQL fragment (safe, parameterized). Bypasses string validation. */
	async executeSql(fragment: ReturnType<typeof sql>) {
		return this.db.execute(fragment);
	}

	/** Ensure the extension has its own schema. */
	async ensureSchema(): Promise<void> {
		const schemaName = `ext_${this.extName}`;
		await this.db.execute(
			sql`CREATE SCHEMA IF NOT EXISTS ${sql.identifier(schemaName)}`,
		);
		// Grant access to extension schema
		await this.db.execute(
			sql`GRANT ALL ON SCHEMA ${sql.identifier(schemaName)} TO beluga_ext`,
		);
	}
}
