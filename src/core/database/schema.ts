// ── Drizzle schema ──────────────────────────────────────────────
// Ported from migrations/001_init_schema.sql + 002_ext_role.sql

import {
	pgTable,
	uuid,
	text,
	bigserial,
	bigint,
	jsonb,
	timestamp,
	uniqueIndex,
	index,
} from "drizzle-orm/pg-core";

export const sessions = pgTable(
	"sessions",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		source: text("source").notNull(),
		sourceId: text("source_id").notNull(),
		status: text("status").notNull().default("pending"),
		sandboxId: text("sandbox_id"),
		metadata: jsonb("metadata")
			.notNull()
			.$type<Record<string, unknown>>()
			.default({}),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		uniqueIndex("sessions_source_idx").on(table.source, table.sourceId),
		index("sessions_status_idx").on(table.status),
		index("sessions_updated_at_idx").on(table.updatedAt),
	],
);

export const events = pgTable(
	"events",
	{
		id: bigserial("id", { mode: "number" }).primaryKey(),
		sessionId: uuid("session_id")
			.notNull()
			.references(() => sessions.id, { onDelete: "cascade" }),
		seq: bigint("seq", { mode: "number" }).notNull(),
		type: text("type").notNull(),
		data: jsonb("data").notNull().$type<Record<string, unknown>>().default({}),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		uniqueIndex("events_session_seq_idx").on(table.sessionId, table.seq),
		index("events_type_idx").on(table.sessionId, table.type),
		index("events_data_idx").on(table.data),
	],
);
