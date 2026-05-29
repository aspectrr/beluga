// ── Provider model cache ───────────────────────────────────────
// Polls each provider's /v1/models endpoint, caches available models.

import type { Logger } from "pino";
import type { LLMConfig } from "../config/config.js";

// ── Provider model types ───────────────────────────────────────

/** Model entry from /models response (OpenAI spec). */
export interface ProviderModel {
	id: string;
	object?: string;
	created?: number;
	owned_by?: string;
}

/** /models response shape. */
interface ProviderModelsResponse {
	object?: string;
	data: ProviderModel[];
}

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export class ProviderModelCache {
	private cache = new Map<string, ProviderModel[]>();
	private timers: ReturnType<typeof setInterval>[] = [];
	private logger: Logger;
	private providers: Map<string, LLMConfig>;

	constructor(providers: Record<string, LLMConfig>, logger: Logger) {
		this.logger = logger.child({ component: "model-cache" });
		this.providers = new Map(Object.entries(providers));
	}

	/** Start polling all providers. */
	start(): void {
		// Initial fetch
		for (const name of this.providers.keys()) {
			this.fetchModels(name).catch(() => {});
		}

		// Periodic refresh
		const timer = setInterval(() => {
			for (const name of this.providers.keys()) {
				this.fetchModels(name).catch(() => {});
			}
		}, POLL_INTERVAL_MS);

		this.timers.push(timer);
		this.logger.info(
			{ providers: Array.from(this.providers.keys()) },
			"model cache started",
		);
	}

	/** Stop polling. */
	stop(): void {
		for (const t of this.timers) clearInterval(t);
		this.timers = [];
	}

	/** Add or update a provider at runtime. */
	setProvider(name: string, config: LLMConfig): void {
		this.providers.set(name, config);
		this.fetchModels(name).catch(() => {});
	}

	/** Remove a provider. */
	removeProvider(name: string): void {
		this.providers.delete(name);
		this.cache.delete(name);
	}

	/** Get cached models for a provider. Returns empty array if not yet fetched. */
	getModels(providerName: string): ProviderModel[] {
		return this.cache.get(providerName) ?? [];
	}

	/** Get all cached models across all providers. */
	getAllModels(): Record<string, ProviderModel[]> {
		const result: Record<string, ProviderModel[]> = {};
		for (const [name] of this.providers) {
			const models = this.cache.get(name);
			if (models) result[name] = models;
		}
		return result;
	}

	/** Force-refresh models for a specific provider. */
	async refresh(providerName: string): Promise<ProviderModel[]> {
		await this.fetchModels(providerName);
		return this.getModels(providerName);
	}

	private async fetchModels(name: string): Promise<void> {
		const config = this.providers.get(name);
		if (!config) return;

		const baseUrl = config.endpoint.replace(/\/$/, "");
		const url = `${baseUrl}/models`;

		try {
			const resp = await fetch(url, {
				method: "GET",
				headers: {
					Authorization: `Bearer ${config.apiKey}`,
				},
				signal: AbortSignal.timeout(15000),
			});

			if (!resp.ok) {
				this.logger.warn(
					{ provider: name, status: resp.status },
					"failed to fetch models",
				);
				return;
			}

			const data = (await resp.json()) as ProviderModelsResponse;
			const models = (data.data ?? []).sort((a, b) => a.id.localeCompare(b.id));

			this.cache.set(name, models);
			this.logger.debug(
				{ provider: name, count: models.length },
				"models fetched",
			);
		} catch (err) {
			this.logger.warn({ provider: name, err }, "model fetch failed");
		}
	}
}
