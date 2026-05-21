// ── LLM client ────────────────────────────────────────────────
// OpenAI-compatible chat completions client with full usage tracking.

import type { Logger } from "pino";
import type { LLMConfig } from "../config/config.js";
import type { LLMToolDef } from "../tools/registry.js";

// ── Types ──────────────────────────────────────────────────────

export interface ChatMessage {
	role: "system" | "user" | "assistant" | "tool";
	content?: string;
	tool_calls?: LLMToolCall[];
	tool_call_id?: string;
}

export interface LLMToolCall {
	id: string;
	type: "function";
	function: {
		name: string;
		arguments: string;
	};
}

export interface ChatRequest {
	model?: string;
	messages: ChatMessage[];
	tools?: LLMToolDef[];
	temperature?: number;
	max_tokens?: number;
	stream?: boolean;
}

export interface ChatChoice {
	index: number;
	message: {
		role: string;
		content?: string;
		tool_calls?: LLMToolCall[];
	};
	finish_reason: string;
}

/** Full usage from OpenAI-compatible /chat/completions response. */
export interface TokenUsage {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
	/** Prompt tokens served from cache (OpenAI: prompt_tokens_details.cached_tokens). */
	prompt_tokens_details?: {
		cached_tokens?: number;
		cache_write_tokens?: number;
	};
	/** Anthropic-style cache fields when using OpenRouter/proxy. */
	cache_read_input_tokens?: number;
	cache_creation_input_tokens?: number;
}

/** Normalized usage that Beluga tracks — mirrors pi's Usage structure. */
export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
}

export interface ChatResponse {
	id: string;
	choices: ChatChoice[];
	usage?: TokenUsage;
}

export interface StreamChunk {
	choices: Array<{
		index: number;
		delta: {
			role?: string;
			content?: string;
			tool_calls?: Array<{
				index: number;
				id?: string;
				type?: string;
				function?: { name?: string; arguments?: string };
			}>;
		};
		finish_reason: string | null;
	}>;
	usage?: TokenUsage;
}

// ── Helpers ────────────────────────────────────────────────────

/** Extract normalized Usage from an OpenAI-compatible response. */
export function extractUsage(raw: TokenUsage): Usage {
	const promptTokens = raw.prompt_tokens || 0;
	const cacheRead =
		raw.prompt_tokens_details?.cached_tokens ??
		raw.cache_read_input_tokens ??
		0;
	const cacheWrite =
		raw.prompt_tokens_details?.cache_write_tokens ??
		raw.cache_creation_input_tokens ??
		0;
	// Non-cached input = total prompt minus cache hits and writes
	const input = Math.max(0, promptTokens - cacheRead - cacheWrite);
	const output = raw.completion_tokens || 0;

	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
	};
}

/** Merge partial usage from stream chunks (last one wins per field). */
export function mergeStreamUsage(accum: Usage, chunk: TokenUsage): Usage {
	const extracted = extractUsage(chunk);
	// Stream usage is cumulative from the provider — replace, don't add
	return extracted.totalTokens > 0 ? extracted : accum;
}

// ── Client ─────────────────────────────────────────────────────

export class LLMClient {
	private config: LLMConfig;
	private logger: Logger;
	/** Last response's usage — available after each chat() call. */
	private _lastUsage: Usage | null = null;

	constructor(config: LLMConfig, logger: Logger) {
		this.config = config;
		this.logger = logger;
	}

	get model(): string {
		return this.config.model;
	}

	setModel(model: string): void {
		this.config.model = model;
	}

	/** Get usage from the most recent chat() or chatStream() call. */
	get lastUsage(): Usage | null {
		return this._lastUsage;
	}

	async chat(request: ChatRequest): Promise<ChatResponse> {
		const url = `${this.config.endpoint.replace(/\/$/, "")}/chat/completions`;

		const body: Record<string, unknown> = {
			model: request.model ?? this.config.model,
			messages: request.messages,
			temperature: request.temperature ?? 0.1,
		};

		if (request.tools && request.tools.length > 0) {
			body.tools = request.tools;
		}

		if (request.max_tokens) {
			body.max_tokens = request.max_tokens;
		}

		this.logger.debug(
			{ model: body.model, msgCount: request.messages.length },
			"LLM request",
		);

		const resp = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${this.config.apiKey}`,
			},
			body: JSON.stringify(body),
		});

		if (!resp.ok) {
			const text = await resp.text();
			throw new Error(`LLM request failed (${resp.status}): ${text}`);
		}

		const data = (await resp.json()) as ChatResponse;

		// Track usage
		if (data.usage) {
			this._lastUsage = extractUsage(data.usage);
			this.logger.debug(
				{
					model: body.model,
					usage: this._lastUsage,
					choices: data.choices?.length,
				},
				"LLM response",
			);
		} else {
			this.logger.debug(
				{ model: body.model, choices: data.choices?.length },
				"LLM response (no usage)",
			);
		}

		return data;
	}

	async *chatStream(request: ChatRequest): AsyncGenerator<StreamChunk> {
		const url = `${this.config.endpoint.replace(/\/$/, "")}/chat/completions`;

		const body: Record<string, unknown> = {
			model: request.model ?? this.config.model,
			messages: request.messages,
			temperature: request.temperature ?? 0.1,
			stream: true,
			// Request usage in streaming response (OpenAI supports this)
			stream_options: { include_usage: true },
		};

		if (request.tools && request.tools.length > 0) {
			body.tools = request.tools;
		}

		const resp = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${this.config.apiKey}`,
			},
			body: JSON.stringify(body),
		});

		if (!resp.ok) {
			const text = await resp.text();
			throw new Error(`LLM stream request failed (${resp.status}): ${text}`);
		}

		const reader = resp.body?.getReader();
		if (!reader) throw new Error("no response body for streaming");

		const decoder = new TextDecoder();
		let buffer = "";
		let streamUsage: Usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
		};

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";

				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed || trimmed === "data: [DONE]") continue;
					if (!trimmed.startsWith("data: ")) continue;

					try {
						const chunk = JSON.parse(trimmed.slice(6)) as StreamChunk;
						// Track usage from stream chunks
						if (chunk.usage) {
							streamUsage = mergeStreamUsage(streamUsage, chunk.usage);
						}
						yield chunk;
					} catch {
						// Skip malformed chunks
					}
				}
			}
		} finally {
			// Store final stream usage
			if (streamUsage.totalTokens > 0) {
				this._lastUsage = streamUsage;
			}
		}
	}
}
