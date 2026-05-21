import { defineConfig } from "drizzle-kit";

export default defineConfig({
	schema: "./src/core/database/schema.ts",
	out: "./drizzle",
	dialect: "postgresql",
	dbCredentials: {
		host: process.env.BELUGA_DB_HOST || "localhost",
		port: Number(process.env.BELUGA_DB_PORT) || 5432,
		database: process.env.BELUGA_DB_NAME || "beluga",
		user: process.env.BELUGA_DB_USER || "beluga",
		password: process.env.BELUGA_DB_PASSWORD || "beluga",
		ssl: process.env.BELUGA_DB_SSLMODE === "require" ? true : false,
	},
});
