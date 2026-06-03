// ── Agent runner ───────────────────────────────────────────────
// Takes a loaded agent manifest and produces a fully-resolved agent
// configuration (prompt, model, tools) for the Orchestrator.

import { readFile, readdir, stat } from "fs/promises";
import { join } from "path";
import type { Logger } from "pino";
import type {
	AgentManifest,
	ResolvedAgent,
	ResolvedModelConfig,
} from "@aspectrr/beluga-sdk";
import type { Config } from "../config/config.js";
import { resolveAgentLLM } from "../config/config.js";

export interface SkillIndex {
	name: string;
	description: string;
	dir: string;
}

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
	): Promise<{ agent: ResolvedAgent; skills: SkillIndex[] }> {
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

		// Scan skills and build index (name + description only)
		const skills = await this.scanSkills(agentDir);

		// Append skill index to system prompt — agent loads full skill on demand
		if (skills.length > 0) {
			const skillLines = skills
				.map((s) => `- **${s.name}**: ${s.description}`)
				.join("\n");
			systemPrompt += `\n\n# Available Skills\n\nThe following skills are available. Before proceeding with a task, check if any skill matches. If one does, call \`load_skill\` with the skill name to load its full instructions, then follow them.\n\n${skillLines}`;
		}

		// Resolve model from config.json provider → global llm
		const model = this.resolveModel(manifest.name);

		return {
			agent: {
				name: manifest.name,
				systemPrompt,
				model,
				maxIterations: manifest.maxIterations ?? 0, // 0 = unlimited
				maxContextTokens: manifest.maxContextTokens ?? 0, // 0 = auto-detect
				extensions: manifest.extensions ?? [],
			},
			skills,
		};
	}

	/**
	 * Scan SKILL.md files for name + description only.
	 * Returns lightweight index entries (no full content loaded).
	 */
	private async scanSkills(agentDir: string): Promise<SkillIndex[]> {
		const projectSkillsDir = join(agentDir, "..", "..", "skills"); // .beluga/skills/
		const agentSkillsDir = join(agentDir, "skills");

		const skillMap = new Map<string, SkillIndex>();

		// Project-level skills first (lower precedence)
		await this.scanSkillsDir(projectSkillsDir, skillMap);

		// Agent-specific skills (higher precedence, overwrites on collision)
		await this.scanSkillsDir(agentSkillsDir, skillMap);

		return Array.from(skillMap.values());
	}

	private async scanSkillsDir(
		dir: string,
		skillMap: Map<string, SkillIndex>,
	): Promise<void> {
		let entries: string[];
		try {
			entries = await readdir(dir);
		} catch {
			return;
		}

		for (const entry of entries) {
			const skillPath = join(dir, entry);
			let skillStat;
			try {
				skillStat = await stat(skillPath);
			} catch {
				continue;
			}
			if (!skillStat.isDirectory()) continue;

			const skillFile = join(skillPath, "SKILL.md");
			try {
				const raw = await readFile(skillFile, "utf-8");
				const nameMatch = raw.match(/^name:\s*(.+)$/m);
				const descMatch = raw.match(/^description:\s*(.+)$/m);
				const name = nameMatch ? nameMatch[1].trim() : entry;
				const description = descMatch
					? descMatch[1].trim()
					: "No description available.";
				skillMap.set(name, { name, description, dir: skillPath });
			} catch {
				// No SKILL.md — skip
			}
		}
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
