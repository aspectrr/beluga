// ── Agent loader ──────────────────────────────────────────────
// Scans .beluga/agents/ at runtime, loads agent manifests.

import { readdir, stat, readFile } from "fs/promises";
import { join, resolve } from "path";
import type { Logger } from "pino";
import type { AgentManifest } from "@aspectrr/beluga-sdk";

export interface LoadedAgent {
	name: string;
	dir: string;
	manifest: AgentManifest;
}

export async function loadAgents(
	agentsDir: string,
	logger: Logger,
): Promise<LoadedAgent[]> {
	const results: LoadedAgent[] = [];

	let entries: string[];
	try {
		entries = await readdir(agentsDir);
	} catch {
		logger.debug({ dir: agentsDir }, "no agents directory");
		return results;
	}

	for (const entry of entries) {
		const agentPath = join(agentsDir, entry);
		const agentStat = await stat(agentPath);
		if (!agentStat.isDirectory()) continue;

		try {
			const manifest = await loadAgentManifest(agentPath, logger);
			if (manifest) {
				results.push({
					name: manifest.name,
					dir: agentPath,
					manifest,
				});
				logger.info({ agent: manifest.name }, "loaded agent manifest");
			}
		} catch (err) {
			logger.error({ err, path: agentPath }, "failed to load agent");
		}
	}

	return results;
}

async function loadAgentManifest(
	dir: string,
	logger: Logger,
): Promise<AgentManifest | null> {
	const manifestPath = join(dir, "agent.json");
	try {
		const data = await readFile(manifestPath, "utf-8");
		const manifest = JSON.parse(data) as AgentManifest;

		if (!manifest.name) {
			logger.warn({ dir }, "agent.json missing required 'name' field");
			return null;
		}

		if (!manifest.systemPrompt) {
			logger.warn({ dir }, "agent.json missing required 'systemPrompt' field");
			return null;
		}

		return manifest;
	} catch {
		logger.warn({ dir }, "no agent.json found");
		return null;
	}
}
