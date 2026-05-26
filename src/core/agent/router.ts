// ── Session router ──────────────────────────────────────────────
// Resolves source + sourceId → agent name using config.routing.

import type { Config } from "../config/config.js";
import { resolveRouting } from "../config/config.js";
import type { Logger } from "pino";

export class SessionRouter {
	private routing: Record<string, string>;
	private logger: Logger;

	constructor(config: Config, logger: Logger) {
		this.routing = config.routing;
		this.logger = logger;
	}

	/** Resolve which agent should handle a session from the given source. */
	resolve(source: string, sourceId?: string): string {
		// Exact match: source:sourceId
		if (sourceId) {
			const exact = this.routing[`${source}:${sourceId}`];
			if (exact) {
				this.logger.debug(
					{ source, sourceId, agent: exact },
					"routed via exact match",
				);
				return exact;
			}
		}

		// Bare source match
		const bare = this.routing[source];
		if (bare) {
			this.logger.debug({ source, agent: bare }, "routed via source match");
			return bare;
		}

		// Default fallback
		const defaultAgent = this.routing["_default"] ?? "default";
		this.logger.debug(
			{ source, sourceId, agent: defaultAgent },
			"routed via default",
		);
		return defaultAgent;
	}
}
