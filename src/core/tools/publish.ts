// ── Publish tools ──────────────────────────────────────────────
// Tools for agents to publish new agents/extensions from sandbox → host.
// publish_extension: self-only, updates calling agent's extension list.
// publish_agent: creates new agent (must not exist).

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import type {
	Registry,
	Tool,
	ToolDef,
	ToolContext,
} from "@aspectrr/beluga-sdk";
import type { Logger } from "pino";

// ── Config interfaces for reading/writing ──────────────────────

interface PublishContext {
	/** The agent name that is calling the tool (for self-only enforcement). */
	callingAgent: string;
	/** Path to .beluga/ root on host. */
	belugaDir: string;
	/** Logger. */
	logger: Logger;
}

// ── publish_extension ──────────────────────────────────────────

class PublishExtensionTool implements Tool {
	private ctx: PublishContext;

	constructor(ctx: PublishContext) {
		this.ctx = ctx;
	}

	definition(): ToolDef {
		return {
			name: "publish_extension",
			description:
				"Publish a new extension from your workspace to the host. " +
				"The extension will be available to YOUR agent only. " +
				"You can overwrite extensions you previously created. " +
				"Files are read from your sandbox and written to the host.",
			parameters: {
				type: "object",
				properties: {
					name: {
						type: "string",
						description: "Name for the extension (alphanumeric, dashes ok)",
					},
					path: {
						type: "string",
						description:
							"Workspace path containing extension files (extension.json + index.ts/js)",
					},
				},
				required: ["name", "path"],
			},
		};
	}

	async execute(
		args: Record<string, unknown>,
		toolCtx: ToolContext,
	): Promise<Record<string, unknown>> {
		const name = String(args.name);
		const srcPath = String(args.path);

		if (!toolCtx.sandbox) {
			throw new Error("no sandbox available");
		}

		// Validate name
		if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
			return {
				success: false,
				error: `invalid extension name: "${name}". Use alphanumeric characters, dashes, and underscores only.`,
			};
		}

		// Check if extension already exists and was created by a different agent (or human)
		const extDir = join(this.ctx.belugaDir, "extensions", name);
		if (existsSync(extDir)) {
			// Check if we own it
			const manifestPath = join(extDir, "extension.json");
			if (existsSync(manifestPath)) {
				const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
				if (
					manifest.createdBy &&
					manifest.createdBy !== this.ctx.callingAgent
				) {
					return {
						success: false,
						error: `extension "${name}" was created by "${manifest.createdBy}" or a human. You can only overwrite extensions you created.`,
					};
				}
			}
		}

		// Read extension.json from sandbox to validate
		let extManifest: Record<string, unknown>;
		try {
			const manifestContent = await toolCtx.sandbox.readFile(
				join(srcPath, "extension.json"),
			);
			extManifest = JSON.parse(manifestContent);
		} catch {
			return {
				success: false,
				error: `extension.json not found at ${srcPath}/extension.json in workspace`,
			};
		}

		// Read all files from the source directory in sandbox
		const files = await this.readSandboxDir(toolCtx.sandbox, srcPath);
		if (files.length === 0) {
			return {
				success: false,
				error: `no files found at ${srcPath} in workspace`,
			};
		}

		// Write to host
		mkdirSync(extDir, { recursive: true });
		for (const [filename, content] of files) {
			writeFileSync(join(extDir, filename), content);
		}

		// Stamp provenance
		extManifest.createdBy = this.ctx.callingAgent;
		extManifest.createdAt = new Date().toISOString();
		writeFileSync(
			join(extDir, "extension.json"),
			JSON.stringify(extManifest, null, 2) + "\n",
		);

		// Add to this agent's extension list in agent.json
		this.addToAgentExtensions(name);

		this.ctx.logger.info(
			{ extension: name, agent: this.ctx.callingAgent },
			"extension published",
		);

		return {
			success: true,
			name,
			path: extDir,
			message: `Extension "${name}" published. It is now available to your agent.`,
		};
	}

	private async readSandboxDir(
		sandbox: import("@aspectrr/beluga-sdk").SandboxRunner,
		dir: string,
	): Promise<[string, Buffer | string][]> {
		const files: [string, Buffer | string][] = [];

		// List files via bash
		const result = await sandbox.exec(
			`find ${dir} -maxdepth 1 -type f -name "*.ts" -o -name "*.js" -o -name "*.json" -o -name "*.md"`,
		);

		if (result.exitCode !== 0) {
			return files;
		}

		const filenames = result.stdout
			.split("\n")
			.map((f) => f.trim())
			.filter(Boolean);

		for (const fullPath of filenames) {
			const basename = fullPath.split("/").pop()!;
			try {
				const content = await sandbox.readFile(fullPath);
				files.push([basename, content]);
			} catch {
				// skip unreadable files
			}
		}

		return files;
	}

	private addToAgentExtensions(name: string): void {
		const agentPath = join(
			this.ctx.belugaDir,
			"agents",
			this.ctx.callingAgent,
			"agent.json",
		);

		if (!existsSync(agentPath)) return;

		const manifest = JSON.parse(readFileSync(agentPath, "utf-8"));
		if (!manifest.extensions) manifest.extensions = [];
		if (!manifest.extensions.includes(name)) {
			manifest.extensions.push(name);
			writeFileSync(agentPath, JSON.stringify(manifest, null, 2) + "\n");
		}
	}
}

// ── publish_agent ──────────────────────────────────────────────

class PublishAgentTool implements Tool {
	private ctx: PublishContext;

	constructor(ctx: PublishContext) {
		this.ctx = ctx;
	}

	definition(): ToolDef {
		return {
			name: "publish_agent",
			description:
				"Create a new agent from your workspace files. " +
				"The agent must not already exist. " +
				"The human will need to add routing to config.json and restart Beluga to activate it.",
			parameters: {
				type: "object",
				properties: {
					name: {
						type: "string",
						description: "Name for the new agent (alphanumeric, dashes ok)",
					},
					path: {
						type: "string",
						description:
							"Workspace path containing agent files (agent.json + SYSTEM.md)",
					},
				},
				required: ["name", "path"],
			},
		};
	}

	async execute(
		args: Record<string, unknown>,
		toolCtx: ToolContext,
	): Promise<Record<string, unknown>> {
		const name = String(args.name);
		const srcPath = String(args.path);

		if (!toolCtx.sandbox) {
			throw new Error("no sandbox available");
		}

		// Validate name
		if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
			return {
				success: false,
				error: `invalid agent name: "${name}". Use alphanumeric characters, dashes, and underscores only.`,
			};
		}

		// Cannot overwrite existing agents
		const agentDir = join(this.ctx.belugaDir, "agents", name);
		if (existsSync(agentDir)) {
			return {
				success: false,
				error: `agent "${name}" already exists. Cannot overwrite existing agents.`,
			};
		}

		// Cannot publish self
		if (name === this.ctx.callingAgent) {
			return {
				success: false,
				error: "Cannot publish over yourself. Agents cannot modify themselves.",
			};
		}

		// Validate agent.json in sandbox
		let agentManifest: Record<string, unknown>;
		try {
			const manifestContent = await toolCtx.sandbox.readFile(
				join(srcPath, "agent.json"),
			);
			agentManifest = JSON.parse(manifestContent);
		} catch {
			return {
				success: false,
				error: `agent.json not found at ${srcPath}/agent.json in workspace`,
			};
		}

		if (!agentManifest.name) {
			return {
				success: false,
				error: "agent.json must have a 'name' field",
			};
		}

		if (!agentManifest.systemPrompt) {
			return {
				success: false,
				error: "agent.json must have a 'systemPrompt' field",
			};
		}

		// Check system prompt file exists
		const promptFileName = String(agentManifest.systemPrompt);
		try {
			await toolCtx.sandbox.readFile(join(srcPath, promptFileName));
		} catch {
			return {
				success: false,
				error: `system prompt file "${promptFileName}" not found at ${srcPath}/ in workspace`,
			};
		}

		// Read all files from source dir
		const files = await this.readSandboxDir(toolCtx.sandbox, srcPath);
		if (files.length === 0) {
			return {
				success: false,
				error: `no files found at ${srcPath} in workspace`,
			};
		}

		// Write to host
		mkdirSync(agentDir, { recursive: true });
		for (const [filename, content] of files) {
			writeFileSync(join(agentDir, filename), content);
		}

		this.ctx.logger.info(
			{ agent: name, createdBy: this.ctx.callingAgent },
			"agent published",
		);

		return {
			success: true,
			name,
			path: agentDir,
			message: `Agent "${name}" created at ${agentDir}. The human needs to add routing to .beluga/config.json and restart Beluga to activate it.`,
		};
	}

	private async readSandboxDir(
		sandbox: import("@aspectrr/beluga-sdk").SandboxRunner,
		dir: string,
	): Promise<[string, Buffer | string][]> {
		const files: [string, Buffer | string][] = [];

		const result = await sandbox.exec(
			`find ${dir} -maxdepth 1 -type f -name "*.ts" -o -name "*.js" -o -name "*.json" -o -name "*.md"`,
		);

		if (result.exitCode !== 0) {
			return files;
		}

		const filenames = result.stdout
			.split("\n")
			.map((f) => f.trim())
			.filter(Boolean);

		for (const fullPath of filenames) {
			const basename = fullPath.split("/").pop()!;
			try {
				const content = await sandbox.readFile(fullPath);
				files.push([basename, content]);
			} catch {
				// skip unreadable files
			}
		}

		return files;
	}
}

// ── Registration ───────────────────────────────────────────────

export interface PublishToolContext {
	callingAgent: string;
	belugaDir: string;
	logger: Logger;
}

export function registerPublishTools(
	registry: Registry,
	ctx: PublishToolContext,
): void {
	registry.register(new PublishExtensionTool(ctx));
	registry.register(new PublishAgentTool(ctx));
}
