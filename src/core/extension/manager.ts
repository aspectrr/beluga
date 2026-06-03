// ── Extension manager ─────────────────────────────────────────
// Re-exports from beluga-sdk + adds runtime manager logic.

import type { ExtensionContext } from "./context.js";
import type { Logger } from "pino";

// Re-export Extension interface from SDK
export type { Extension } from "@aspectrr/beluga-sdk";

export class ExtensionManager {
	private extensions: Array<{
		ext: import("@aspectrr/beluga-sdk").Extension;
		ctx: ExtensionContext;
	}> = [];
	private logger: Logger;

	constructor(logger: Logger) {
		this.logger = logger;
	}

	register(
		ext: import("@aspectrr/beluga-sdk").Extension,
		ctx: ExtensionContext,
	): void {
		this.extensions.push({ ext, ctx });
	}

	/** Get all registered extensions (for workspace hooks, etc.) */
	getAll(): Array<import("@aspectrr/beluga-sdk").Extension> {
		return this.extensions.map((e) => e.ext);
	}

	async initAll(): Promise<void> {
		for (const { ext, ctx } of this.extensions) {
			this.logger.info({ extension: ext.name }, "initializing extension");
			// Snapshot tool names before init so we can tag new ones
			const beforeNames = new Set(ctx.registry.list().map((t) => t.name));
			await ext.init(ctx);
			// Re-register new tools with the extension name as source
			const afterNames = ctx.registry.list().map((t) => t.name);
			for (const name of afterNames) {
				if (!beforeNames.has(name)) {
					const tool = ctx.registry.get(name);
					if (tool) {
						ctx.registry.register(tool, ext.name);
					}
				}
			}
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
