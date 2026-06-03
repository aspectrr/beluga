// ── Tool registry ──────────────────────────────────────────────
// Core tool interfaces that extensions implement to register tools.

export interface ToolDef {
	name: string;
	description: string;
	parameters: Record<string, unknown>; // JSON Schema
}

export interface ToolContext {
	sessionId: string;
	sandbox: SandboxRunner | null;
	eventStore: import("./context.js").EventStore | null;
	/** Name of the agent this tool invocation belongs to. */
	agent?: string;
}

export interface SandboxRunner {
	exec(cmd: string, args?: string[]): Promise<ExecResult>;
	readFile(path: string): Promise<string>;
	writeFile(path: string, content: Buffer | string): Promise<void>;
}

export interface ExecResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export interface Tool {
	definition(): ToolDef;
	execute(
		args: Record<string, unknown>,
		ctx: ToolContext,
	): Promise<Record<string, unknown>>;
}

export class Registry {
	private tools: Map<string, Tool> = new Map();
	/** Maps tool name → extension name that registered it. */
	private sources: Map<string, string> = new Map();

	register(tool: Tool, source?: string): void {
		this.tools.set(tool.definition().name, tool);
		if (source) this.sources.set(tool.definition().name, source);
	}

	get(name: string): Tool | undefined {
		return this.tools.get(name);
	}

	list(): ToolDef[] {
		return Array.from(this.tools.values()).map((t) => t.definition());
	}

	/** Get the extension name that registered a tool, or undefined for core tools. */
	getSource(name: string): string | undefined {
		return this.sources.get(name);
	}

	async execute(
		name: string,
		args: Record<string, unknown>,
		ctx: ToolContext,
	): Promise<Record<string, unknown>> {
		const tool = this.tools.get(name);
		if (!tool) throw new Error(`unknown tool: ${name}`);
		return tool.execute(args, ctx);
	}

	unregister(name: string): void {
		this.tools.delete(name);
		this.sources.delete(name);
	}
}

// ── LLM tool format ────────────────────────────────────────────

export interface LLMToolDef {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	};
}

export function toLLMTools(tools: ToolDef[]): LLMToolDef[] {
	return tools.map((t) => ({
		type: "function" as const,
		function: {
			name: t.name,
			description: t.description,
			parameters: t.parameters,
		},
	}));
}
