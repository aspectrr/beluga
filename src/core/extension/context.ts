// ── Extension context ─────────────────────────────────────────
// Runtime implementation of the SDK's ExtensionContext interface.
// Adds concrete types that bind to the actual Beluga runtime.

import type { Registry } from "@beluga/sdk";
import type { SessionStore } from "../session/store.js";
import type { EventStore } from "../eventstore/store.js";
import type { ExtDB } from "../database/extdb.js";
import type { Logger } from "pino";
import type { Session } from "../model/types.js";

export interface ExtensionContext {
	config: Record<string, unknown>;
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
	shared: Record<string, unknown>;
}
