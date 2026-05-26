// ── @beluga/sdk ───────────────────────────────────────────────
// Public API for building Beluga extensions.

// Extension lifecycle
export type { Extension } from "./extension.js";

// Extension context (what gets passed to init)
export type {
	ExtensionContext,
	ExtDB,
	EventStore,
	SessionStore,
} from "./context.js";

// Tool interfaces
export {
	Registry,
	toLLMTools,
	type Tool,
	type ToolDef,
	type ToolContext,
	type SandboxRunner,
	type ExecResult,
	type LLMToolDef,
} from "./tools.js";

// Agent types
export type {
	AgentManifest,
	AgentModelConfig,
	AgentConfigField,
	ResolvedAgent,
	RoutingEntry,
} from "./agent.js";

// Domain types
export {
	SessionStatus,
	EventType,
	type SessionStatus as SessionStatusType,
	type EventType as EventTypeType,
	type Session,
	type Event,
	type UserMessagePayload,
	type AgentMessagePayload,
	type ToolCallPayload,
	type ToolResultPayload,
} from "./types.js";
