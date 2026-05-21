// ── Session store ──────────────────────────────────────────────
// Ported from internal/core/session/store.go

import { eq, and, desc } from "drizzle-orm";
import type { DbType } from "../database/pool.js";
import { sessions } from "../database/schema.js";
import type { Session, SessionStatus } from "../model/types.js";

export class SessionStore {
	private db: DbType;

	constructor(db: DbType) {
		this.db = db;
	}

	async create(
		source: string,
		sourceId: string,
		metadata: Record<string, unknown> = {},
	): Promise<Session> {
		const [row] = await this.db
			.insert(sessions)
			.values({ source, sourceId, metadata, status: "pending" })
			.returning();

		return row as Session;
	}

	async get(id: string): Promise<Session | null> {
		const rows = await this.db
			.select()
			.from(sessions)
			.where(eq(sessions.id, id))
			.limit(1);

		return rows.length > 0 ? (rows[0] as Session) : null;
	}

	async getBySource(source: string, sourceId: string): Promise<Session | null> {
		const rows = await this.db
			.select()
			.from(sessions)
			.where(and(eq(sessions.source, source), eq(sessions.sourceId, sourceId)))
			.limit(1);

		return rows.length > 0 ? (rows[0] as Session) : null;
	}

	async updateStatus(id: string, status: SessionStatus): Promise<void> {
		await this.db.update(sessions).set({ status }).where(eq(sessions.id, id));
	}

	async setSandboxId(id: string, sandboxId: string): Promise<void> {
		await this.db
			.update(sessions)
			.set({ sandboxId })
			.where(eq(sessions.id, id));
	}

	async clearSandboxId(id: string): Promise<void> {
		await this.db
			.update(sessions)
			.set({ sandboxId: null })
			.where(eq(sessions.id, id));
	}

	async updateMetadata(
		id: string,
		metadata: Record<string, unknown>,
	): Promise<void> {
		// JSON merge via SQL
		await this.db
			.update(sessions)
			.set({
				metadata: sql`COALESCE(metadata, '{}')::jsonb || ${JSON.stringify(metadata)}::jsonb`,
			})
			.where(eq(sessions.id, id));
	}

	async listByStatus(
		status: SessionStatus,
		limit = 50,
		offset = 0,
	): Promise<Session[]> {
		return this.db
			.select()
			.from(sessions)
			.where(eq(sessions.status, status))
			.orderBy(desc(sessions.updatedAt))
			.limit(limit)
			.offset(offset) as Promise<Session[]>;
	}

	/** Clear source_id for completed sessions (archive). */
	async clearSource(id: string): Promise<void> {
		await this.db
			.update(sessions)
			.set({ sourceId: "" })
			.where(eq(sessions.id, id));
	}
}

// Need sql import for metadata merge
import { sql } from "drizzle-orm";
