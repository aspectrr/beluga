// ── Extension context ─────────────────────────────────────────
// Runtime implementation of the SDK's ExtensionContext interface.
// Adds concrete types that bind to the actual Beluga runtime.

import type { Registry } from "@aspectrr/beluga-sdk";
import type { SessionStore } from "../session/store.js";
import type { EventStore } from "../eventstore/store.js";
import type { ExtDB } from "../database/extdb.js";
import type { Logger } from "pino";
import type { Session } from "../model/types.js";

export interface ExtensionContext {
	config: Record<string, unknown>;
	/** Instance name for this extension. Same as extension name for base extensions.
	 *  For aliases (e.g. `linear-acme` extending `linear`), this is the alias name.
	 *  Use this to prefix tool names, webhook paths, etc. */
	instanceName: string;
	registry: Registry;
	sessions: SessionStore;
	events: EventStore;
	db: ExtDB;
	logger: Logger;
	promptDir: string;
	createSession: (
		source: string,
		sourceId: string,
		initialMessage: string,
		metadata?: Record<string, unknown>,
	) => Promise<Session>;
	continueSession: (
		sessionId: string,
		message: string,
		metadata?: Record<string, unknown>,
	) => Promise<Session>;
	shared: Record<string, unknown>;
}
