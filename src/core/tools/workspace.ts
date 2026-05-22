// ── Workspace tools ────────────────────────────────────────────
// Built-in tools for workspace sandbox interaction.

import type {
	Registry,
	Tool,
	ToolDef,
	ToolContext,
	SandboxRunner,
} from "@aspectrr/beluga-sdk";

class WorkspaceBashTool implements Tool {
	definition(): ToolDef {
		return {
			name: "workspace_bash",
			description:
				"Execute a bash command in the workspace sandbox. Returns stdout, stderr, and exit code.",
			parameters: {
				type: "object",
				properties: {
					command: {
						type: "string",
						description: "The bash command to execute",
					},
				},
				required: ["command"],
			},
		};
	}

	async execute(
		args: Record<string, unknown>,
		ctx: ToolContext,
	): Promise<Record<string, unknown>> {
		if (!ctx.sandbox) throw new Error("no sandbox available for this session");
		const result = await ctx.sandbox.exec(String(args.command));
		return {
			stdout: result.stdout,
			stderr: result.stderr,
			exit_code: result.exitCode,
		};
	}
}

class WorkspaceReadFileTool implements Tool {
	definition(): ToolDef {
		return {
			name: "workspace_read_file",
			description: "Read a file from the workspace sandbox.",
			parameters: {
				type: "object",
				properties: {
					path: {
						type: "string",
						description: "Path to the file (relative to workspace root)",
					},
				},
				required: ["path"],
			},
		};
	}

	async execute(
		args: Record<string, unknown>,
		ctx: ToolContext,
	): Promise<Record<string, unknown>> {
		if (!ctx.sandbox) throw new Error("no sandbox available for this session");
		const content = await ctx.sandbox.readFile(String(args.path));
		return { content };
	}
}

class WorkspaceWriteFileTool implements Tool {
	definition(): ToolDef {
		return {
			name: "workspace_edit_file",
			description: "Write or edit a file in the workspace sandbox.",
			parameters: {
				type: "object",
				properties: {
					path: {
						type: "string",
						description: "Path to the file (relative to workspace root)",
					},
					content: {
						type: "string",
						description: "The content to write",
					},
				},
				required: ["path", "content"],
			},
		};
	}

	async execute(
		args: Record<string, unknown>,
		ctx: ToolContext,
	): Promise<Record<string, unknown>> {
		if (!ctx.sandbox) throw new Error("no sandbox available for this session");
		await ctx.sandbox.writeFile(String(args.path), String(args.content));
		return { success: true };
	}
}

export function registerWorkspaceTools(registry: Registry): void {
	registry.register(new WorkspaceBashTool());
	registry.register(new WorkspaceReadFileTool());
	registry.register(new WorkspaceWriteFileTool());
}
