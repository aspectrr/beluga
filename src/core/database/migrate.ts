// ── Auto-migration ──────────────────────────────────────────────
// Creates tables if they don't exist. Runs at startup before any queries.

import { sql } from "drizzle-orm";
import type { DbType } from "./pool.js";

export async function runMigrations(db: DbType): Promise<void> {
	await db.execute(sql`
		CREATE TABLE IF NOT EXISTS sessions (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			source TEXT NOT NULL,
			source_id TEXT NOT NULL,
			agent TEXT,
			status TEXT NOT NULL DEFAULT 'pending',
			sandbox_id TEXT,
			metadata JSONB NOT NULL DEFAULT '{}',
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		);
	`);

	await db.execute(sql`
		CREATE INDEX IF NOT EXISTS sessions_source_idx ON sessions (source, source_id);
	`);
	await db.execute(sql`
		CREATE INDEX IF NOT EXISTS sessions_status_idx ON sessions (status);
	`);
	await db.execute(sql`
		CREATE INDEX IF NOT EXISTS sessions_updated_at_idx ON sessions (updated_at);
	`);
	await db.execute(sql`
		CREATE INDEX IF NOT EXISTS sessions_agent_idx ON sessions (agent);
	`);

	await db.execute(sql`
		CREATE TABLE IF NOT EXISTS events (
			id BIGSERIAL PRIMARY KEY,
			session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
			seq BIGINT NOT NULL,
			type TEXT NOT NULL,
			data JSONB NOT NULL DEFAULT '{}',
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		);
	`);

	await db.execute(sql`
		CREATE UNIQUE INDEX IF NOT EXISTS events_session_seq_idx ON events (session_id, seq);
	`);
	await db.execute(sql`
		CREATE INDEX IF NOT EXISTS events_type_idx ON events (session_id, type);
	`);
	await db.execute(sql`
		CREATE INDEX IF NOT EXISTS events_data_idx ON events USING gin (data);
	`);
}
