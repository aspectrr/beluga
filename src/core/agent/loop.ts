// ── Agent orchestrator ────────────────────────────────────────
// Ported from internal/core/agent/loop.go

import type { SessionStore } from "../session/store.js";
import type { EventStore } from "../eventstore/store.js";
import type { LLMClient } from "./llm.js";
import type { ContextBuilder } from "./context.js";
import type { Compactor } from "./compactor.js";
import type { ToolDef } from "../tools/registry.js";
import type { Session } from "../model/types.js";
import type { Logger } from "pino";

export interface ToolExecutor {
	executeTool(
		name: string,
		args: Record<string, unknown>,
		sessionId: string,
	): Promise<Record<string, unknown>>;
}

export class Orchestrator {
	private sessions: SessionStore;
	private events: EventStore;
	private llm: LLMClient;
	private toolExecutor: ToolExecutor;
	private contextBuilder: ContextBuilder;
	private compactor: Compactor;
	private logger: Logger;
	private tools: ToolDef[] = [];
	private maxIterations: number;

	constructor(
		sessions: SessionStore,
		events: EventStore,
		llm: LLMClient,
		toolExecutor: ToolExecutor,
		contextBuilder: ContextBuilder,
		compactor: Compactor,
		maxIterations: number,
		logger: Logger,
	) {
		this.sessions = sessions;
		this.events = events;
		this.llm = llm;
		this.toolExecutor = toolExecutor;
		this.contextBuilder = contextBuilder;
		this.compactor = compactor;
		this.maxIterations = maxIterations;
		this.logger = logger;
	}

	setTools(tools: ToolDef[]): void {
		this.tools = tools;
		this.contextBuilder.setTools(tools);
	}

	/** Handle a new session: create it, seed initial message, start agent loop. */
	async handleNewSession(
		source: string,
		sourceId: string,
		initialMessage: string,
		metadata: Record<string, unknown> = {},
	): Promise<Session> {
		const session = await this.sessions.create(source, sourceId, metadata);

		// Seed initial user message
		await this.events.append(session.id, "user_message", {
			content: initialMessage,
		});

		// Start agent loop
		this.startRun(session.id).catch((err) => {
			this.logger.error({ err, sessionId: session.id }, "agent loop failed");
		});

		return session;
	}

	/** Start the agent loop for a session. */
	async startRun(sessionId: string): Promise<void> {
		const session = await this.sessions.get(sessionId);
		if (!session) throw new Error(`session not found: ${sessionId}`);

		if (session.status !== "pending" && session.status !== "running") {
			throw new Error(
				`session ${sessionId} is ${session.status}, cannot start`,
			);
		}

		await this.sessions.updateStatus(sessionId, "running");
		await this.events.append(sessionId, "status_transition", {
			from: session.status,
			to: "running",
		});

		this.logger.info({ sessionId }, "agent loop started");

		for (let i = 0; i < this.maxIterations; i++) {
			const result = await this.runIteration(sessionId);
			if (result === "done") break;
		}
	}

	private async runIteration(sessionId: string): Promise<"continue" | "done"> {
		// Fetch all events
		const allEvents = await this.events.getEvents(sessionId, 0, 10000);

		// Build context
		const messages = this.contextBuilder.build(allEvents);

		// Check if compaction needed
		if (this.compactor.needsCompaction(messages)) {
			await this.compactor.compact(sessionId, allEvents);
		}

		// Build LLM tool definitions
		const { toLLMTools } = await import("../tools/registry.js");
		const llmTools = this.tools.length > 0 ? toLLMTools(this.tools) : undefined;

		// Call LLM
		const response = await this.llm.chat({
			messages,
			tools: llmTools,
		});

		const choice = response.choices[0];
		if (!choice) {
			await this.terminate(sessionId, true);
			return "done";
		}

		// Handle tool calls
		if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
			for (const tc of choice.message.tool_calls) {
				// Record tool_call event
				const args = JSON.parse(tc.function.arguments);
				await this.events.append(sessionId, "tool_call", {
					tool_name: tc.function.name,
					args,
					call_id: tc.id,
				});

				try {
					// Execute tool
					const result = await this.toolExecutor.executeTool(
						tc.function.name,
						args,
						sessionId,
					);

					await this.events.append(sessionId, "tool_result", {
						call_id: tc.id,
						output: JSON.stringify(result),
						is_error: false,
					});
				} catch (err) {
					await this.events.append(sessionId, "tool_result", {
						call_id: tc.id,
						output: String(err instanceof Error ? err.message : err),
						is_error: true,
					});
				}
			}
			return "continue";
		}

		// Handle content response
		if (choice.message.content) {
			await this.events.append(sessionId, "agent_message", {
				content: choice.message.content,
				model: this.llm.model,
				usage: this.llm.lastUsage,
			});
		}

		// Check finish reason
		if (choice.finish_reason === "stop") {
			await this.terminate(sessionId, false);
			return "done";
		}

		if (choice.finish_reason === "length") {
			// Context window full — continue (compaction will handle it next iteration)
			return "continue";
		}

		// Any other finish reason — complete
		await this.terminate(sessionId, false);
		return "done";
	}

	async interrupt(sessionId: string): Promise<void> {
		await this.sessions.updateStatus(sessionId, "suspended");
		await this.events.append(sessionId, "interrupt", {
			reason: "user requested interrupt",
			requires_action: false,
		});
	}

	async resume(sessionId: string): Promise<void> {
		await this.sessions.updateStatus(sessionId, "running");
		this.startRun(sessionId).catch((err) => {
			this.logger.error({ err, sessionId }, "agent loop failed on resume");
		});
	}

	async terminate(sessionId: string, failed: boolean): Promise<void> {
		const status = failed ? "failed" : "completed";
		await this.sessions.updateStatus(sessionId, status);
		await this.events.append(sessionId, "status_transition", {
			from: "running",
			to: status,
		});

		// Clear source for completed sessions
		if (!failed) {
			await this.sessions.clearSource(sessionId);
		}

		this.logger.info({ sessionId, status }, "session terminated");
	}
}
