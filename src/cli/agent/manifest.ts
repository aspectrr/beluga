// ── Agent manifest ────────────────────────────────────────────
// Loads agent.json from an agent directory.

import { readFileSync, existsSync } from "fs";
import { join } from "path";

export interface AgentConfigField {
	name: string;
	type: string;
	description: string;
	required?: boolean;
	default?: string;
	env_var?: string;
	secret?: boolean;
}

export interface AgentManifest {
	name: string;
	version?: string;
	description?: string;
	systemPrompt: string;
	maxIterations?: number;
	maxContextTokens?: number;
	extensions?: string[];
	extensionSources?: Record<string, string>;
	entrypoint?: string;
	config?: AgentConfigField[];
}

export function loadAgentManifest(dir: string): AgentManifest | null {
	const path = join(dir, "agent.json");
	if (existsSync(path)) {
		const raw = readFileSync(path, "utf-8");
		return JSON.parse(raw) as AgentManifest;
	}
	return null;
}
