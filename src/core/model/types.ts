// ── Domain types ─────────────────────────────────────────────────
// Ported from internal/core/model/types.go

// Session statuses
export const SessionStatus = {
	Pending: "pending",
	Running: "running",
	Suspended: "suspended",
	Completed: "completed",
	Failed: "failed",
} as const;
export type SessionStatus = (typeof SessionStatus)[keyof typeof SessionStatus];

// Event types
export const EventType = {
	UserMessage: "user_message",
	AgentMessage: "agent_message",
	ToolCall: "tool_call",
	ToolResult: "tool_result",
	Interrupt: "interrupt",
	StatusTransition: "status_transition",
	Error: "error",
	Compacted: "compacted",
} as const;
export type EventType = (typeof EventType)[keyof typeof EventType];

export interface Session {
	id: string;
	source: string;
	sourceId: string;
	status: SessionStatus;
	sandboxId: string | null;
	metadata: Record<string, unknown>;
	createdAt: Date;
	updatedAt: Date;
}

export interface Event {
	id: number;
	sessionId: string;
	seq: number;
	type: EventType | string;
	data: Record<string, unknown>;
	createdAt: Date;
}

// ── Event payloads ──────────────────────────────────────────────

export interface UserMessagePayload {
	content: string;
	attachments?: string[];
}

export interface AgentMessagePayload {
	content: string;
	model?: string;
	tokensUsed?: number;
}

export interface ToolCallPayload {
	tool_name: string;
	args: Record<string, unknown>;
	call_id: string;
}

export interface ToolResultPayload {
	call_id: string;
	output: string;
	is_error: boolean;
}

export interface InterruptPayload {
	reason: string;
	requires_action: boolean;
}

export interface StatusTransitionPayload {
	from: string;
	to: string;
}

export interface ErrorPayload {
	message: string;
	stack_trace?: string;
	recoverable: boolean;
}

export interface CompactedPayload {
	summary: string;
	compactedUpToSeq: number;
	tokensSaved: number;
}
