// ── Database connection pool ────────────────────────────────────
// Ported from internal/core/database/pool.go

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";
import type { DatabaseConfig } from "../config/config.js";

export function createPool(config: DatabaseConfig) {
	const client = postgres(
		`postgres://${config.user}:${config.password}@${config.host}:${config.port}/${config.name}`,
		{
			max: config.maxConnections,
			ssl: config.sslmode === "require" ? true : false,
		},
	);

	const db = drizzle(client, { schema });
	return { db, client };
}

export type DbType = ReturnType<typeof drizzle<typeof schema>>;
