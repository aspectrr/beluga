// ── Agent runner ───────────────────────────────────────────────
// Takes a loaded agent manifest and produces a fully-resolved agent
// configuration (prompt, model, tools) for the Orchestrator.

import { readFile } from "fs/promises";
import { join } from "path";
import type { Logger } from "pino";
import type {
	AgentManifest,
	ResolvedAgent,
	ResolvedModelConfig,
} from "@aspectrr/beluga-sdk";
import type { Config } from "../config/config.js";
import { resolveAgentLLM } from "../config/config.js";

export class AgentRunner {
	private config: Config;
	private logger: Logger;

	constructor(config: Config, logger: Logger) {
		this.config = config;
		this.logger = logger;
	}

	/** Resolve an agent manifest into a fully-merged configuration. */
	async resolve(
		manifest: AgentManifest,
		agentDir: string,
	): Promise<ResolvedAgent> {
		// Load system prompt
		const promptPath = join(agentDir, manifest.systemPrompt);
		let systemPrompt: string;
		try {
			systemPrompt = await readFile(promptPath, "utf-8");
		} catch {
			this.logger.warn(
				{ agent: manifest.name, path: promptPath },
				"system prompt file not found, using empty prompt",
			);
			systemPrompt = "";
		}

		// Resolve model from config.json provider → global llm
		const model = this.resolveModel(manifest.name);

		return {
			name: manifest.name,
			systemPrompt,
			model,
			maxIterations: manifest.maxIterations ?? 0, // 0 = unlimited
			maxContextTokens: manifest.maxContextTokens ?? 0, // 0 = auto-detect
			extensions: manifest.extensions ?? [],
		};
	}

	private resolveModel(agentName: string): ResolvedModelConfig {
		const llm = resolveAgentLLM(this.config, agentName);
		return {
			endpoint: llm.endpoint,
			apiKey: llm.apiKey,
			model: llm.model,
			embeddingModel: llm.embeddingModel,
			embeddingDimensions: llm.embeddingDimensions,
		};
	}
}
