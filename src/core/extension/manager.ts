// ── Extension manager ─────────────────────────────────────────
// Re-exports from beluga-sdk + adds runtime manager logic.

import type { ExtensionContext } from "./context.js";
import type { Logger } from "pino";

// Re-export Extension interface from SDK
export type { Extension } from "@aspectrr/beluga-sdk";

export class ExtensionManager {
	private extensions: Array<{
		ext: import("beluga-sdk").Extension;
		ctx: ExtensionContext;
	}> = [];
	private logger: Logger;

	constructor(logger: Logger) {
		this.logger = logger;
	}

	register(ext: import("beluga-sdk").Extension, ctx: ExtensionContext): void {
		this.extensions.push({ ext, ctx });
	}

	async initAll(): Promise<void> {
		for (const { ext, ctx } of this.extensions) {
			this.logger.info({ extension: ext.name }, "initializing extension");
			await ext.init(ctx);
		}
	}

	async startAll(signal: AbortSignal): Promise<void> {
		const promises = this.extensions.map(({ ext }) =>
			ext.start(signal).catch((err) => {
				this.logger.error(
					{ err, extension: ext.name },
					"extension start failed",
				);
			}),
		);
		await Promise.all(promises);
	}

	async stopAll(): Promise<void> {
		const reversed = [...this.extensions].reverse();
		for (const { ext } of reversed) {
			try {
				await ext.stop();
				this.logger.info({ extension: ext.name }, "extension stopped");
			} catch (err) {
				this.logger.error(
					{ err, extension: ext.name },
					"extension stop failed",
				);
			}
		}
	}
}
