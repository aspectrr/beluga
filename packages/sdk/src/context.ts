// ── Extension context ─────────────────────────────────────────
// The context object passed to Extension.init().
// Provides everything an extension needs to interact with Beluga.

import type { Registry } from "./tools.js";
import type { Session, SessionStatus } from "./types.js";

/**
 * Restricted extension database access.
 * Extensions should not import this directly — it is provided via ExtensionContext.
 */
export interface ExtDB {
	readonly name: string;
	query(querySql: string, ...args: unknown[]): Promise<unknown>;
	executeSql(fragment: unknown): Promise<unknown>;
	ensureSchema(): Promise<void>;
}

/**
 * Event store for reading session events.
 */
export interface EventStore {
	append(
		sessionId: string,
		type: string,
		data: Record<string, unknown>,
	): Promise<import("./types.js").Event>;
	getEvents(
		sessionId: string,
		afterSeq?: number,
		limit?: number,
	): Promise<import("./types.js").Event[]>;
	getLatest(sessionId: string): Promise<import("./types.js").Event | null>;
}

/**
 * Session store for querying sessions.
 */
export interface SessionStore {
	create(
		source: string,
		sourceId: string,
		metadata?: Record<string, unknown>,
		agent?: string | null,
	): Promise<Session>;
	get(id: string): Promise<Session | null>;
	getBySource(source: string, sourceId: string): Promise<Session | null>;
	updateStatus(id: string, status: SessionStatus): Promise<void>;
	listByStatus(
		status: SessionStatus,
		limit?: number,
		offset?: number,
	): Promise<Session[]>;
}

export interface ExtensionContext {
	/** Extension-specific config from beluga.yaml */
	config: Record<string, unknown>;

	/** Instance name for this extension. Same as extension name for base extensions.
	 *  For aliases (e.g. `linear-acme` extending `linear`), this is the alias name.
	 *  Use this to prefix tool names, webhook paths, etc. */
	instanceName: string;

	/** Tool registry — call ctx.registry.register(tool) to add tools */
	registry: Registry;

	/** Session store — query and create sessions */
	sessions: SessionStore;

	/** Event store — read and append events */
	events: EventStore;

	/** Restricted database access */
	db: ExtDB;

	/** Logger scoped to this extension */
	logger: import("pino").Logger;

	/** Path to the prompts directory */
	promptDir: string;

	/** Create a new agent session from an external trigger */
	createSession: (
		source: string,
		sourceId: string,
		initialMessage: string,
		metadata?: Record<string, unknown>,
	) => Promise<Session>;

	/** Continue an existing session with a new user message */
	continueSession: (
		sessionId: string,
		message: string,
		metadata?: Record<string, unknown>,
	) => Promise<Session>;

	/** Shared state for cross-extension communication.
	 *  Extensions read/write arbitrary keys.
	 *  Example: host sets `grpcProvider`, remora reads it. */
	shared: Record<string, unknown>;
}
