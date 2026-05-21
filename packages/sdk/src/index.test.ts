// ── @beluga/sdk tests ─────────────────────────────────────────
// Verifies all exported types, interfaces, and classes work correctly.

import { describe, test, expect } from "bun:test";
import {
	Registry,
	toLLMTools,
	type Tool,
	type ToolDef,
	type ToolContext,
	type Extension,
	type ExtensionContext,
	type ExtDB,
	type EventStore,
	type SessionStore,
	type GRPCProvider,
	SessionStatus,
	EventType,
	type Session,
	type Event,
} from "@beluga/sdk";

// ── Tool tests ────────────────────────────────────────────────

class EchoTool implements Tool {
	definition(): ToolDef {
		return {
			name: "echo",
			description: "Echoes back the input",
			parameters: {
				type: "object",
				properties: {
					message: { type: "string", description: "Message to echo" },
				},
				required: ["message"],
			},
		};
	}

	async execute(
		args: Record<string, unknown>,
		_ctx: ToolContext,
	): Promise<Record<string, unknown>> {
		return { echo: args.message };
	}
}

describe("Registry", () => {
	test("register and retrieve a tool", () => {
		const registry = new Registry();
		const tool = new EchoTool();
		registry.register(tool);

		const def = registry.get("echo");
		expect(def).toBeDefined();
		expect(def!.definition().name).toBe("echo");
	});

	test("list returns all tool definitions", () => {
		const registry = new Registry();
		registry.register(new EchoTool());

		class PingTool implements Tool {
			definition(): ToolDef {
				return { name: "ping", description: "ping", parameters: {} };
			}
			async execute() {
				return { pong: true };
			}
		}
		registry.register(new PingTool());

		const list = registry.list();
		expect(list).toHaveLength(2);
		expect(list.map((t) => t.name).sort()).toEqual(["echo", "ping"]);
	});

	test("unregister removes a tool", () => {
		const registry = new Registry();
		registry.register(new EchoTool());
		expect(registry.list()).toHaveLength(1);

		registry.unregister("echo");
		expect(registry.list()).toHaveLength(0);
		expect(registry.get("echo")).toBeUndefined();
	});

	test("execute calls the tool", async () => {
		const registry = new Registry();
		registry.register(new EchoTool());

		const ctx: ToolContext = {
			sessionId: "test",
			sandbox: null,
			eventStore: null,
		};
		const result = await registry.execute("echo", { message: "hello" }, ctx);
		expect(result).toEqual({ echo: "hello" });
	});

	test("execute throws for unknown tool", async () => {
		const registry = new Registry();
		const ctx: ToolContext = {
			sessionId: "test",
			sandbox: null,
			eventStore: null,
		};
		expect(registry.execute("missing", {}, ctx)).rejects.toThrow(
			"unknown tool: missing",
		);
	});
});

// ── toLLMTools ────────────────────────────────────────────────

describe("toLLMTools", () => {
	test("converts tool defs to LLM format", () => {
		const defs: ToolDef[] = [
			{ name: "a", description: "tool a", parameters: { type: "object" } },
			{ name: "b", description: "tool b", parameters: { type: "object" } },
		];

		const llm = toLLMTools(defs);
		expect(llm).toHaveLength(2);
		expect(llm[0]).toEqual({
			type: "function",
			function: {
				name: "a",
				description: "tool a",
				parameters: { type: "object" },
			},
		});
	});
});

// ── Domain types ──────────────────────────────────────────────

describe("Domain types", () => {
	test("SessionStatus values are correct", () => {
		expect(SessionStatus.Pending).toBe("pending");
		expect(SessionStatus.Running).toBe("running");
		expect(SessionStatus.Completed).toBe("completed");
		expect(SessionStatus.Failed).toBe("failed");
	});

	test("EventType values are correct", () => {
		expect(EventType.UserMessage).toBe("user_message");
		expect(EventType.AgentMessage).toBe("agent_message");
		expect(EventType.ToolCall).toBe("tool_call");
		expect(EventType.ToolResult).toBe("tool_result");
	});
});

// ── Extension interface compliance ────────────────────────────

describe("Extension interface", () => {
	test("can implement the Extension interface", async () => {
		const mockCtx: ExtensionContext = {
			config: {},
			registry: new Registry(),
			sessions: {} as SessionStore,
			events: {} as EventStore,
			db: {} as ExtDB,
			logger: {} as import("pino").Logger,
			promptDir: "/tmp",
			createSession: async () => ({}) as Session,
			shared: {},
		};

		let initialized = false;
		let started = false;
		let stopped = false;

		const ext: Extension = {
			name: "test-ext",
			async init(ctx: ExtensionContext) {
				expect(ctx.registry).toBeDefined();
				ctx.registry.register(new EchoTool());
				initialized = true;
			},
			async start() {
				started = true;
			},
			async stop() {
				stopped = true;
			},
		};

		await ext.init(mockCtx);
		expect(initialized).toBe(true);
		expect(mockCtx.registry.get("echo")).toBeDefined();

		await ext.start(AbortSignal.timeout(100));
		expect(started).toBe(true);

		await ext.stop();
		expect(stopped).toBe(true);
	});

	test("shared context allows cross-extension communication", () => {
		const ctx: ExtensionContext = {
			config: {},
			registry: new Registry(),
			sessions: {} as SessionStore,
			events: {} as EventStore,
			db: {} as ExtDB,
			logger: {} as import("pino").Logger,
			promptDir: "/tmp",
			createSession: async () => ({}) as Session,
			shared: {},
		};

		// Simulate host extension writing
		ctx.shared["grpcProvider"] = { start: async () => {}, stop: () => {} };

		// Simulate remora reading
		const provider = ctx.shared["grpcProvider"] as {
			start: () => Promise<void>;
			stop: () => void;
		};
		expect(provider).toBeDefined();
		expect(typeof provider.stop).toBe("function");
	});
});

// ── Export shape ──────────────────────────────────────────────

describe("SDK exports", () => {
	test("all expected types are importable", () => {
		// If this compiles, all types resolve correctly
		expect(Registry).toBeDefined();
		expect(toLLMTools).toBeDefined();
		expect(SessionStatus).toBeDefined();
		expect(EventType).toBeDefined();
	});
});
