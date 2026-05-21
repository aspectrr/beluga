// ── Extension interface ────────────────────────────────────────
// Every Beluga extension must implement this interface.

import type { ExtensionContext } from "./context.js";

export interface Extension {
	/** Unique identifier for this extension */
	name: string;

	/** Called once at startup. Register tools, parse config, etc. */
	init(ctx: ExtensionContext): Promise<void>;

	/** Called after all extensions are initialized. Start background work here. */
	start(signal: AbortSignal): Promise<void>;

	/** Called on graceful shutdown. Clean up resources. */
	stop(): Promise<void>;
}
