// ── Context compactor ─────────────────────────────────────────
// Uses actual token usage from LLM responses for compaction decisions.
// Falls back to chars/4 estimate only for cut-point calculation.

import type { Event } from "../model/types.js";
import type { LLMClient, ChatMessage } from "./llm.js";
import type { ContextBuilder } from "./context.js";
import type { EventStore } from "../eventstore/store.js";
import type { Logger } from "pino";

// Defaults matching pi's compaction settings
const DEFAULT_RESERVE_TOKENS = 16384; // Compact when this close to limit
const DEFAULT_KEEP_RECENT_TOKENS = 20000; // Keep this many tokens from end

export class Compactor {
	private events: EventStore;
	private llm: LLMClient;
	private builder: ContextBuilder;
	private logger: Logger;
	private contextWindow: number;
	private reserveTokens: number;
	private keepRecentTokens: number;

	constructor(
		events: EventStore,
		llm: LLMClient,
		builder: ContextBuilder,
		logger: Logger,
		options?: {
			contextWindow?: number;
			reserveTokens?: number;
			keepRecentTokens?: number;
		},
	) {
		this.events = events;
		this.llm = llm;
		this.builder = builder;
		this.logger = logger;
		this.contextWindow = options?.contextWindow ?? builder.getMaxTokens();
		this.reserveTokens = options?.reserveTokens ?? DEFAULT_RESERVE_TOKENS;
		this.keepRecentTokens =
			options?.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS;
	}

	/**
	 * Check if compaction is needed using actual usage from the last LLM response.
	 * This is the real check — uses tokens the provider reported.
	 */
	needsCompaction(messages: ChatMessage[]): boolean {
		const usage = this.llm.lastUsage;
		if (usage && usage.totalTokens > 0) {
			// Real usage from provider — use it
			return usage.totalTokens > this.contextWindow - this.reserveTokens;
		}
		// No real usage yet (first turn) — estimate
		const estimated = this.builder.estimateTokens(messages);
		return estimated > this.contextWindow - this.reserveTokens;
	}

	/**
	 * Get current context usage info (for status/display).
	 */
	getContextUsage(): {
		tokens: number;
		contextWindow: number;
		percent: number;
	} | null {
		const usage = this.llm.lastUsage;
		if (!usage || usage.totalTokens === 0) return null;
		return {
			tokens: usage.totalTokens,
			contextWindow: this.contextWindow,
			percent: (usage.totalTokens / this.contextWindow) * 100,
		};
	}

	async compact(sessionId: string, events: Event[]): Promise<number> {
		// Find cut point: keep keepRecentTokens from the end
		const recentChars = this.keepRecentTokens * 4; // rough chars budget
		let boundary = events.length;

		// Walk backwards from end, accumulating estimated size
		let accumulated = 0;
		for (let i = events.length - 1; i >= 0; i--) {
			const evtSize = this.estimateEventSize(events[i]);
			accumulated += evtSize;
			if (accumulated >= recentChars) {
				boundary = i;
				break;
			}
		}

		// Find clean boundary (don't split tool_call/tool_result pairs)
		for (let i = boundary; i >= 0; i--) {
			const type = events[i].type;
			if (type !== "tool_call" && type !== "tool_result") {
				boundary = i;
				break;
			}
		}

		const oldEvents = events.slice(0, boundary);
		if (oldEvents.length === 0) return 0;

		// Convert old events to text for summarization
		const text = oldEvents
			.map((e) => {
				switch (e.type) {
					case "user_message":
						return `User: ${(e.data as { content?: string }).content ?? ""}`;
					case "agent_message":
						return `Agent: ${(e.data as { content?: string }).content ?? ""}`;
					case "tool_call": {
						const d = e.data as {
							tool_name?: string;
							args?: Record<string, unknown>;
						};
						return `Tool Call: ${d.tool_name}(${JSON.stringify(d.args)})`;
					}
					case "tool_result": {
						const d = e.data as { output?: string };
						return `Tool Result: ${d.output?.slice(0, 500)}`;
					}
					default:
						return null;
				}
			})
			.filter(Boolean)
			.join("\n");

		// Ask LLM to summarize
		const tokensBefore = this.llm.lastUsage?.totalTokens ?? 0;

		const resp = await this.llm.chat({
			messages: [
				{
					role: "system",
					content:
						"Summarize the following conversation history concisely. Preserve key decisions, outcomes, and any important context needed to continue.",
				},
				{ role: "user", content: text },
			],
			temperature: 0,
		});

		const summary = resp.choices[0]?.message?.content ?? "";
		const tokensSaved =
			tokensBefore > 0
				? tokensBefore - (this.llm.lastUsage?.totalTokens ?? tokensBefore)
				: this.builder.estimateTokens(
						oldEvents.map((e) => ({
							role: "user" as const,
							content: JSON.stringify(e.data),
						})),
					);

		// Append compaction event
		await this.events.append(sessionId, "compacted", {
			summary,
			compactedUpToSeq: oldEvents[oldEvents.length - 1].seq,
			tokensBefore,
			tokensSaved,
		});

		this.logger.info(
			{
				sessionId,
				eventsCompacted: oldEvents.length,
				tokensSaved,
				tokensBefore,
			},
			"context compacted",
		);

		return tokensSaved;
	}

	/** Rough size estimate for a single event (chars). */
	private estimateEventSize(event: Event): number {
		const data = JSON.stringify(event.data ?? {});
		return data.length;
	}
}
