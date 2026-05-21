// ── Context builder ───────────────────────────────────────────
// Ported from internal/core/agent/context.go

import type { Event, EventType } from "../model/types.js";
import type { ChatMessage } from "./llm.js";
import type { ToolDef } from "../tools/registry.js";

const DEFAULT_SYSTEM_PROMPT = `You are Beluga, an AI agent that helps users manage tasks and projects.
You have access to tools in a workspace sandbox and can interact with external services via extensions.
Always respond concisely and accurately. When using tools, verify the results before responding.`;

export class ContextBuilder {
	private systemPrompt: string;
	private maxTokens: number;

	constructor(systemPrompt?: string) {
		this.systemPrompt = systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
		this.maxTokens = 128000;
	}

	setSystemPrompt(prompt: string): void {
		this.systemPrompt = prompt;
	}

	setTools(_tools: ToolDef[]): void {
		// Tools are passed to LLM separately, not embedded in context
	}

	getMaxTokens(): number {
		return this.maxTokens;
	}

	setMaxTokens(n: number): void {
		this.maxTokens = n;
	}

	/** Build chat messages from events. */
	build(events: Event[]): ChatMessage[] {
		const messages: ChatMessage[] = [];

		// Find the latest compaction event
		let compactedUpTo = 0;
		let summary = "";
		for (let i = events.length - 1; i >= 0; i--) {
			if (events[i].type === "compacted") {
				const data = events[i].data as {
					summary?: string;
					compactedUpToSeq?: number;
				};
				summary = data.summary ?? "";
				compactedUpTo = data.compactedUpToSeq ?? events[i].seq;
				break;
			}
		}

		// Build system prompt (include compaction summary if present)
		let sysPrompt = this.systemPrompt;
		if (summary) {
			sysPrompt += `\n\n## Conversation Summary\n${summary}`;
		}
		messages.push({ role: "system", content: sysPrompt });

		// Convert events after compaction point to chat messages
		for (const event of events) {
			if (event.seq <= compactedUpTo) continue;

			switch (event.type as EventType) {
				case "user_message": {
					const data = event.data as { content?: string };
					if (data.content) {
						messages.push({ role: "user", content: data.content });
					}
					break;
				}

				case "agent_message": {
					const data = event.data as { content?: string };
					if (data.content) {
						messages.push({ role: "assistant", content: data.content });
					}
					break;
				}

				case "tool_call": {
					const data = event.data as {
						tool_name?: string;
						args?: Record<string, unknown>;
						call_id?: string;
					};
					if (data.tool_name && data.call_id) {
						// Find previous assistant message or create one
						const lastMsg = messages[messages.length - 1];
						if (lastMsg?.role === "assistant") {
							lastMsg.tool_calls = lastMsg.tool_calls ?? [];
							lastMsg.tool_calls.push({
								id: data.call_id,
								type: "function",
								function: {
									name: data.tool_name,
									arguments: JSON.stringify(data.args ?? {}),
								},
							});
						} else {
							messages.push({
								role: "assistant",
								content: "",
								tool_calls: [
									{
										id: data.call_id,
										type: "function",
										function: {
											name: data.tool_name,
											arguments: JSON.stringify(data.args ?? {}),
										},
									},
								],
							});
						}
					}
					break;
				}

				case "tool_result": {
					const data = event.data as { call_id?: string; output?: string };
					if (data.call_id) {
						messages.push({
							role: "tool",
							tool_call_id: data.call_id,
							content: data.output ?? "",
						});
					}
					break;
				}
			}
		}

		// Truncate from front if over budget (keep system + recent)
		while (
			this.estimateTokens(messages) > this.maxTokens &&
			messages.length > 2
		) {
			// Remove oldest non-system message
			messages.splice(1, 1);
		}

		return messages;
	}

	/** Rough token estimate (chars / 4). */
	estimateTokens(messages: ChatMessage[]): number {
		let total = 0;
		for (const msg of messages) {
			total += (msg.content?.length ?? 0) / 4;
			if (msg.tool_calls) {
				for (const tc of msg.tool_calls) {
					total += (tc.function.arguments?.length ?? 0) / 4;
				}
			}
		}
		return Math.ceil(total);
	}
}
