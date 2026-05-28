// ── Config system ──────────────────────────────────────────────

import { readFileSync, existsSync } from "fs";

export interface LLMConfig {
	endpoint: string;
	apiKey: string;
	model: string;
	embeddingModel?: string;
	embeddingDimensions?: number;
}

export interface DatabaseConfig {
	host: string;
	port: number;
	name: string;
	user: string;
	password: string;
	sslmode: string;
	maxConnections: number;
	extRolePassword: string;
}

export interface WorkspaceConfig {
	dockerHost: string;
	agentImage: string;
	maxConcurrent: number;
	idleTimeout: number; // seconds
	cpuLimit: string;
	memoryLimit: string;
	networkMode: string;
}

export interface ExtensionEntry {
	enabled: boolean;
	[key: string]: unknown;
}

export interface AgentEntry {
	enabled: boolean;
	[key: string]: unknown;
}

export interface Config {
	llm: LLMConfig;
	database: DatabaseConfig;
	workspace: WorkspaceConfig;
	extensions: Record<string, ExtensionEntry>;
	agents: Record<string, AgentEntry>;
	routing: Record<string, string>;
}

function expandEnvVars(value: string): string {
	return value.replace(/\$\{([^}]+)\}/g, (_, expr) => {
		const [name, fallback] = expr.split(":-");
		const envVal = process.env[name];
		if (envVal !== undefined && envVal !== "") return envVal;
		if (fallback !== undefined) return fallback;
		return "";
	});
}

function expandEnvVarsDeep<T>(obj: T): T {
	if (typeof obj === "string") return expandEnvVars(obj) as T;
	if (Array.isArray(obj)) return obj.map(expandEnvVarsDeep) as T;
	if (obj && typeof obj === "object") {
		const result: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(obj)) {
			result[k] = expandEnvVarsDeep(v);
		}
		return result as T;
	}
	return obj;
}

export function loadConfig(path: string): Config {
	if (!existsSync(path)) {
		throw new Error(`config file not found: ${path}`);
	}

	const raw = readFileSync(path, "utf-8");
	const parsed = JSON.parse(raw) as Record<string, unknown>;
	const expanded = expandEnvVarsDeep(parsed);

	return parseConfig(expanded);
}

function parseConfig(raw: Record<string, unknown>): Config {
	const db = (raw.database ?? {}) as Record<string, unknown>;
	const ws = (raw.workspace ?? {}) as Record<string, unknown>;
	const ag = (raw.agent ?? {}) as Record<string, unknown>;
	const llm = (raw.llm ?? {}) as Record<string, unknown>;
	const ext = (raw.extensions ?? {}) as Record<string, unknown>;
	const agents = (raw.agents ?? {}) as Record<string, unknown>;
	const routing = (raw.routing ?? {}) as Record<string, unknown>;

	// Parse idle timeout (e.g. "1h" → 3600, "30s" → 30)
	const idleTimeoutRaw = String(ws.idleTimeout ?? ws.idle_timeout ?? "1h");
	let idleTimeout = 3600;
	const match = idleTimeoutRaw.match(/^(\d+)(s|m|h)$/);
	if (match) {
		const n = parseInt(match[1]);
		if (match[2] === "s") idleTimeout = n;
		else if (match[2] === "m") idleTimeout = n * 60;
		else if (match[2] === "h") idleTimeout = n * 3600;
	}

	return {
		llm: {
			endpoint: String(llm.endpoint ?? ""),
			apiKey: String(llm.apiKey ?? llm.api_key ?? ""),
			model: String(llm.model ?? ""),
			embeddingModel: llm.embeddingModel
				? String(llm.embeddingModel)
				: undefined,
			embeddingDimensions: llm.embeddingDimensions
				? Number(llm.embeddingDimensions)
				: undefined,
		},
		database: {
			host: String(db.host ?? "localhost"),
			port: Number(db.port ?? 5432),
			name: String(db.name ?? "beluga"),
			user: String(db.user ?? "beluga"),
			password: String(db.password ?? "beluga"),
			sslmode: String(db.sslmode ?? "disable"),
			maxConnections: Number(db.maxConnections ?? db.max_connections ?? 20),
			extRolePassword: String(
				db.extRolePassword ?? db.ext_role_password ?? "beluga_ext",
			),
		},
		workspace: {
			dockerHost: String(ws.dockerHost ?? ws.docker_host ?? ""),
			agentImage: String(
				ws.agentImage ?? ws.agent_image ?? "beluga/agent-workspace:latest",
			),
			maxConcurrent: Number(ws.maxConcurrent ?? ws.max_concurrent ?? 10),
			idleTimeout,
			cpuLimit: String(ws.cpuLimit ?? ws.cpu_limit ?? "1.0"),
			memoryLimit: String(ws.memoryLimit ?? ws.memory_limit ?? "1g"),
			networkMode: String(ws.networkMode ?? ws.network_mode ?? "none"),
		},
		extensions: parseExtensions(ext),
		agents: parseAgentEntries(agents),
		routing: parseRouting(routing),
	};
}

function parseExtensions(
	raw: Record<string, unknown>,
): Record<string, ExtensionEntry> {
	const result: Record<string, ExtensionEntry> = {};
	for (const [name, val] of Object.entries(raw)) {
		if (val === null || val === undefined) {
			result[name] = { enabled: true };
		} else if (typeof val === "object") {
			const obj = val as Record<string, unknown>;
			result[name] = {
				enabled: obj.enabled !== false,
				...obj,
			};
		} else {
			result[name] = { enabled: true };
		}
	}
	return result;
}

function parseAgentEntries(
	raw: Record<string, unknown>,
): Record<string, AgentEntry> {
	const result: Record<string, AgentEntry> = {};
	for (const [name, val] of Object.entries(raw)) {
		if (val === null || val === undefined) {
			result[name] = { enabled: true };
		} else if (typeof val === "object") {
			const obj = val as Record<string, unknown>;
			result[name] = {
				enabled: obj.enabled !== false,
				...obj,
			};
		} else {
			result[name] = { enabled: true };
		}
	}
	return result;
}

function parseRouting(raw: Record<string, unknown>): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, val] of Object.entries(raw)) {
		result[key] = String(val);
	}
	return result;
}

// ── Config helpers ──────────────────────────────────────────────

export function isExtensionEnabled(config: Config, name: string): boolean {
	const ext = config.extensions[name];
	return ext?.enabled === true;
}

export function extensionRawConfig(
	config: Config,
	name: string,
): Record<string, unknown> {
	const ext = config.extensions[name];
	if (!ext) return {};
	const { enabled, ...rest } = ext;
	return rest;
}

export function enabledExtensions(config: Config): string[] {
	return Object.entries(config.extensions)
		.filter(([, v]) => v.enabled)
		.map(([k]) => k);
}

// ── Agent config helpers ────────────────────────────────────────

export function isAgentEnabled(config: Config, name: string): boolean {
	const agent = config.agents[name];
	return agent?.enabled === true;
}

export function enabledAgents(config: Config): string[] {
	return Object.entries(config.agents)
		.filter(([, v]) => v.enabled)
		.map(([k]) => k);
}

/** Resolve which agent should handle a session from the given source/sourceId. */
export function resolveRouting(
	config: Config,
	source: string,
	sourceId?: string,
): string {
	// Exact match: source:sourceId
	if (sourceId) {
		const exact = config.routing[`${source}:${sourceId}`];
		if (exact) return exact;
	}

	// Bare source match
	const bare = config.routing[source];
	if (bare) return bare;

	// Default
	return config.routing["_default"] ?? "default";
}
