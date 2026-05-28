// ── Agent runner ───────────────────────────────────────────────
// Takes a loaded agent manifest and produces a fully-resolved agent
// configuration (prompt, model, tools) for the Orchestrator.

import { readFile } from "fs/promises";
import { join } from "path";
import type { Logger } from "pino";
import type {
	AgentManifest,
	AgentModelConfig,
	ResolvedAgent,
} from "@aspectrr/beluga-sdk";
import type { Config, LLMConfig } from "../config/config.js";

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

		// Merge model: agent override → global config
		const model = this.resolveModel(manifest.model);

		return {
			name: manifest.name,
			systemPrompt,
			model,
			maxIterations: manifest.maxIterations ?? 0, // 0 = unlimited
			maxContextTokens: manifest.maxContextTokens ?? 0, // 0 = auto-detect
			extensions: manifest.extensions ?? [],
		};
	}

	private resolveModel(agentModel?: AgentModelConfig): AgentModelConfig {
		const global = this.config.llm;
		if (!agentModel) {
			return {
				endpoint: global.endpoint,
				apiKey: global.apiKey,
				model: global.model,
				embeddingModel: global.embeddingModel,
				embeddingDimensions: global.embeddingDimensions,
			};
		}

		return {
			endpoint: agentModel.endpoint ?? global.endpoint,
			apiKey: agentModel.apiKey ?? global.apiKey,
			model: agentModel.model ?? global.model,
			embeddingModel: agentModel.embeddingModel ?? global.embeddingModel,
			embeddingDimensions:
				agentModel.embeddingDimensions ?? global.embeddingDimensions,
		};
	}
}
