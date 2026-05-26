// ── Agent types ────────────────────────────────────────────────
// Defines the manifest format for Beluga agents.

/** Model configuration override for an agent. All fields optional — falls back to global config. */
export interface AgentModelConfig {
	endpoint?: string;
	apiKey?: string;
	model?: string;
	embeddingModel?: string;
	embeddingDimensions?: number;
}

/** Routing rule inside config.json (not in agent.json). */
export interface RoutingEntry {
	source: string;
	sourceId?: string;
	agent: string;
}

/** agent.json manifest — lives in .beluga/agents/{name}/agent.json */
export interface AgentManifest {
	/** Unique agent identifier */
	name: string;

	/** Semantic version */
	version?: string;

	/** Human-readable description */
	description?: string;

	/** Path to system prompt file (relative to agent directory) */
	systemPrompt: string;

	/** Optional model override. Omit to use global config. */
	model?: AgentModelConfig;

	/** Max agent loop iterations. Omit for global default. */
	maxIterations?: number;

	/** Max context tokens. Omit for global default. */
	maxContextTokens?: number;

	/** Extensions this agent should have access to (additive, names must match installed extensions). */
	extensions?: string[];

	/** Entrypoint for custom init logic (optional). */
	entrypoint?: string;

	/** Config fields the agent declares (same pattern as extensions). */
	config?: AgentConfigField[];
}

export interface AgentConfigField {
	name: string;
	type: string;
	description: string;
	required?: boolean;
	default?: string;
	env_var?: string;
	secret?: boolean;
}

/** Resolved agent ready for use by the runner. */
export interface ResolvedAgent {
	name: string;
	systemPrompt: string;
	model: AgentModelConfig;
	maxIterations: number;
	maxContextTokens: number;
	extensions: string[];
}
