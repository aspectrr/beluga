// ── API types ──────────────────────────────────────────────────

export interface Provider {
	name: string;
	endpoint: string;
	apiKey: string;
	model: string;
	embeddingModel?: string;
	embeddingDimensions?: number;
}

export interface AgentConfig {
	name: string;
	enabled: boolean;
	provider?: string;
	systemPrompt?: string;
	model?: string;
	extensions?: string[];
	maxIterations?: number;
	maxContextTokens?: number;
}

export interface ProviderModel {
	id: string;
	object?: string;
	created?: number;
	owned_by?: string;
}

export interface Session {
	id: string;
	source: string;
	sourceId: string;
	agent: string | null;
	status: string;
	createdAt: string;
	updatedAt: string;
}

export interface Event {
	id: number;
	sessionId: string;
	seq: number;
	type: string;
	data: Record<string, unknown>;
	createdAt: string;
}

// ── API calls ──────────────────────────────────────────────────

const BASE = "/api";

async function json<T>(url: string, init?: RequestInit): Promise<T> {
	const res = await fetch(`${BASE}${url}`, {
		headers: { "Content-Type": "application/json" },
		...init,
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`${res.status}: ${text}`);
	}
	return res.json();
}

// Providers
export const api = {
	listProviders: () => json<Provider[]>("/providers"),

	saveProvider: (name: string, provider: Omit<Provider, "name">) =>
		json<Provider>(`/providers/${encodeURIComponent(name)}`, {
			method: "PUT",
			body: JSON.stringify(provider),
		}),

	deleteProvider: (name: string) =>
		fetch(`${BASE}/providers/${encodeURIComponent(name)}`, {
			method: "DELETE",
		}).then((r) => {
			if (!r.ok) throw new Error(`${r.status}`);
		}),

	// Provider models
	listProviderModels: (name: string) =>
		json<ProviderModel[]>(`/providers/${encodeURIComponent(name)}/models`),

	listAllModels: () => json<Record<string, ProviderModel[]>>("/models"),

	// Agents
	listAgents: () => json<AgentConfig[]>("/agents"),

	getAgent: (name: string) =>
		json<AgentConfig>(`/agents/${encodeURIComponent(name)}`),

	updateAgent: (name: string, config: Partial<AgentConfig>) =>
		json<AgentConfig>(`/agents/${encodeURIComponent(name)}`, {
			method: "PUT",
			body: JSON.stringify(config),
		}),

	// Sessions
	listSessions: (limit = 50) => json<Session[]>(`/sessions?limit=${limit}`),

	createSession: (
		source: string,
		sourceId: string,
		message: string,
		agent?: string,
	) =>
		json<Session>("/sessions", {
			method: "POST",
			body: JSON.stringify({ source, sourceId, message, agent }),
		}),

	sendMessage: (sessionId: string, message: string) =>
		json<Session>(`/sessions/${encodeURIComponent(sessionId)}/messages`, {
			method: "POST",
			body: JSON.stringify({ message }),
		}),

	// Events
	getEvents: (sessionId: string) =>
		json<Event[]>(`/sessions/${encodeURIComponent(sessionId)}/events`),

	// SSE stream for events
	streamEvents: (sessionId: string, afterSeq = 0): EventSource => {
		return new EventSource(
			`${BASE}/sessions/${encodeURIComponent(sessionId)}/events/stream?afterSeq=${afterSeq}`,
		);
	},
};
