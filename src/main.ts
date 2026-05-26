// ── Beluga main entry point ───────────────────────────────────
// Ported from cmd/beluga/main.go

import { Command } from "commander";
import pino from "pino";
import { resolve, join } from "path";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";

// Core
import {
	loadConfig,
	enabledExtensions,
	extensionRawConfig,
	enabledAgents,
	resolveRouting,
} from "./core/config/config.js";
import { createPool } from "./core/database/pool.js";
import { ExtDB, defaultExtPermissions } from "./core/database/extdb.js";
import { EventStore } from "./core/eventstore/store.js";
import { SessionStore } from "./core/session/store.js";
import { Registry, registerWorkspaceTools } from "./core/tools/index.js";
import { registerPublishTools } from "./core/tools/publish.js";
import { WorkspaceManager } from "./core/workspace/manager.js";
import {
	ExtensionManager,
	loadRuntimeExtensions,
} from "./core/extension/index.js";
import { LLMClient } from "./core/agent/llm.js";
import { ContextBuilder } from "./core/agent/context.js";
import { Compactor } from "./core/agent/compactor.js";
import { Orchestrator, type ToolExecutor } from "./core/agent/loop.js";
import { SessionRouter } from "./core/agent/router.js";
import { AgentRunner } from "./core/agent/runner.js";
import { loadAgents, type LoadedAgent } from "./core/agent/loader.js";
import type { ResolvedAgent } from "@aspectrr/beluga-sdk";

// CLI
import { installExtension } from "./cli/extend/install.js";
import { scaffoldExtension } from "./cli/extend/scaffold.js";
import { verifyExtension, printVerifyResult } from "./cli/extend/verify.js";
import { installAgent } from "./cli/agent/install.js";
import { scaffoldAgent } from "./cli/agent/scaffold.js";
import { verifyAgent, printAgentVerifyResult } from "./cli/agent/verify.js";
import { listAgents } from "./cli/agent/list.js";

const logger = pino({
	transport: {
		target: "pino-pretty",
		options: { colorize: true },
	},
});

// ── Tool executor adapter ──────────────────────────────────────
// Adapts Registry → ToolExecutor, wires Sandbox per session

class ToolExecutorAdapter implements ToolExecutor {
	private registry: Registry;
	private workspaceManager: WorkspaceManager;

	constructor(registry: Registry, workspaceManager: WorkspaceManager) {
		this.registry = registry;
		this.workspaceManager = workspaceManager;
	}

	async executeTool(
		name: string,
		args: Record<string, unknown>,
		sessionId: string,
	): Promise<Record<string, unknown>> {
		let sandbox = this.workspaceManager.get(sessionId) ?? null;

		// Auto-create sandbox for workspace tool calls
		if (!sandbox && name.startsWith("workspace_")) {
			sandbox = await this.workspaceManager.create(sessionId);
		}

		return this.registry.execute(name, args, {
			sessionId,
			sandbox,
			eventStore: null,
		});
	}
}

// ── Per-agent orchestrator pool ────────────────────────────────
// Each agent gets its own Orchestrator with its own prompt/model/tools.

interface AgentOrchestrator {
	orchestrator: Orchestrator;
	toolExecutor: ToolExecutorAdapter;
	resolved: ResolvedAgent;
}

// ── Start command ─────────────────────────────────────────────

async function startCommand(configPath: string): Promise<void> {
	logger.info("starting Beluga");

	// Resolve .beluga/ root from config path
	const belugaDir = resolve(configPath, "..");

	// 1. Load config
	const config = loadConfig(configPath);
	logger.info(
		{
			extensions: enabledExtensions(config),
			agents: enabledAgents(config),
			routing: config.routing,
		},
		"config loaded",
	);

	// 2. Database
	const { db, client: pgClient } = createPool(config.database);
	logger.info("database connected");

	// 3. Stores
	const sessionStore = new SessionStore(db);
	const eventStore = new EventStore(db);

	// 4. Tools — global registry for all extensions to register into
	const globalRegistry = new Registry();
	registerWorkspaceTools(globalRegistry);
	logger.info({ count: globalRegistry.list().length }, "core tools registered");

	// 5. Workspace manager
	const workspaceManager = new WorkspaceManager(
		{
			dockerHost: config.workspace.dockerHost,
			agentImage: config.workspace.agentImage,
			idleTimeout: config.workspace.idleTimeout,
			cpuLimit: config.workspace.cpuLimit,
			memoryLimit: config.workspace.memoryLimit,
			networkMode: config.workspace.networkMode,
		},
		logger,
	);

	// 6. Load agents
	const agentsDir = join(belugaDir, "agents");
	const loadedAgents = await loadAgents(agentsDir, logger);
	logger.info({ count: loadedAgents.length }, "agents loaded");

	// Ensure default agent exists
	const hasDefault = loadedAgents.some((a) => a.name === "default");
	if (!hasDefault) {
		logger.info("no default agent found, creating from legacy config");
		loadedAgents.push({
			name: "default",
			dir: join(agentsDir, "default"),
			manifest: {
				name: "default",
				systemPrompt: "SYSTEM.md",
			},
		});
	}

	// 7. Resolve all agents (merge manifests with global config)
	const agentRunner = new AgentRunner(config, logger);
	const resolvedAgents = new Map<string, ResolvedAgent>();

	for (const loaded of loadedAgents) {
		if (!isAgentEnabled(config, loaded.name)) {
			logger.info({ agent: loaded.name }, "agent disabled, skipping");
			continue;
		}
		const resolved = await agentRunner.resolve(loaded.manifest, loaded.dir);
		resolvedAgents.set(loaded.name, resolved);
		logger.info(
			{
				agent: resolved.name,
				extensions: resolved.extensions,
				model: resolved.model.model,
			},
			"agent resolved",
		);
	}

	// 8. Load extensions
	const shared: Record<string, unknown> = {};
	const extMgr = new ExtensionManager(logger);
	const runtimeExtDir = join(belugaDir, "extensions");

	// We need createSession to go through the router, but router needs
	// the orchestrator pool, which we build after extensions load.
	// Use a deferred pattern — create session functions resolve agent at call time.

	const agentOrchestrators = new Map<string, AgentOrchestrator>();

	/** Build or retrieve an orchestrator for the given agent name. */
	function getOrchestrator(agentName: string): AgentOrchestrator | null {
		const existing = agentOrchestrators.get(agentName);
		if (existing) return existing;

		const resolved = resolvedAgents.get(agentName);
		if (!resolved) {
			logger.error({ agent: agentName }, "no resolved agent found");
			return null;
		}

		// Build per-agent LLM client
		const agentLlm = new LLMClient(
			{
				endpoint: resolved.model.endpoint ?? config.llm.endpoint,
				apiKey: resolved.model.apiKey ?? config.llm.apiKey,
				model: resolved.model.model ?? config.llm.model,
				embeddingModel:
					resolved.model.embeddingModel ?? config.llm.embeddingModel,
				embeddingDimensions:
					resolved.model.embeddingDimensions ??
					config.llm.embeddingDimensions,
			},
			logger,
		);

		// Build per-agent context builder
		const contextBuilder = new ContextBuilder(resolved.systemPrompt || undefined);
		contextBuilder.setMaxTokens(resolved.maxContextTokens);

		// Build per-agent tool registry — filtered to this agent's extensions
		const agentRegistry = new Registry();
		registerWorkspaceTools(agentRegistry);

		// Add publish tools scoped to this agent
		registerPublishTools(agentRegistry, {
			callingAgent: agentName,
			belugaDir,
			logger: logger.child({ agent: agentName }),
		});

		// Add tools from extensions this agent uses
		const allTools = globalRegistry.list();
		for (const toolDef of allTools) {
			// workspace_* and publish_* tools are already registered above
			if (
				toolDef.name.startsWith("workspace_") ||
				toolDef.name.startsWith("publish_")
			) {
				continue;
			}

			// Include tool if it comes from an extension this agent has
			const toolPrefix = toolDef.name.split("_")[0];
			if (resolved.extensions.includes(toolPrefix) || resolved.extensions.length === 0) {
				const tool = globalRegistry.get(toolDef.name);
				if (tool) agentRegistry.register(tool);
			}
		}

		// Build orchestrator
		const compactor = new Compactor(eventStore, agentLlm, contextBuilder, logger);
		const toolExecutor = new ToolExecutorAdapter(agentRegistry, workspaceManager);
		const orchestrator = new Orchestrator(
			sessionStore,
			eventStore,
			agentLlm,
			toolExecutor,
			contextBuilder,
			compactor,
			resolved.maxIterations,
			logger,
		);
		orchestrator.setTools(agentRegistry.list());

		const entry: AgentOrchestrator = {
			orchestrator,
			toolExecutor,
			resolved,
		};
		agentOrchestrators.set(agentName, entry);

		logger.info(
			{
				agent: agentName,
				tools: agentRegistry.list().length,
				model: resolved.model.model ?? config.llm.model,
			},
			"orchestrator built for agent",
		);

		return entry;
	}

	// Build router
	const router = new SessionRouter(config, logger);

	// Session creation — routes to the correct agent
	const createSession = async (
		source: string,
		sourceId: string,
		initialMessage: string,
		metadata?: Record<string, unknown>,
	) => {
		const agentName = router.resolve(source, sourceId);
		logger.info({ source, sourceId, agent: agentName }, "session routed");

		const entry = getOrchestrator(agentName);
		if (!entry) {
			throw new Error(`no orchestrator for agent: ${agentName}`);
		}

		return entry.orchestrator.handleNewSession(
			source,
			sourceId,
			initialMessage,
			{ ...metadata, agent: agentName },
		);
	};

	const continueSession = async (
		sessionId: string,
		message: string,
		metadata?: Record<string, unknown>,
	) => {
		// Look up which agent owns this session
		const session = await sessionStore.get(sessionId);
		const agentName =
			(session?.metadata?.agent as string) ?? router.resolve("default");
		const entry = getOrchestrator(agentName);
		if (!entry) {
			throw new Error(`no orchestrator for agent: ${agentName}`);
		}
		return entry.orchestrator.handleContinueSession(sessionId, message, metadata);
	};

	await loadRuntimeExtensions(
		runtimeExtDir,
		extMgr,
		(name: string) => ({
			config: extensionRawConfig(config, name),
			registry: globalRegistry,
			sessions: sessionStore,
			events: eventStore,
			db: new ExtDB(db, name, defaultExtPermissions(name)),
			logger: logger.child({ extension: name }),
			promptDir: join(belugaDir, "prompts"),
			createSession,
			continueSession,
			shared,
		}),
		logger,
	);

	// Initialize extensions
	await extMgr.initAll();
	logger.info(
		{ count: enabledExtensions(config).length },
		"extensions initialized",
	);

	// Pre-build orchestrators for all enabled agents
	for (const agentName of resolvedAgents.keys()) {
		getOrchestrator(agentName);
	}

	// Start extensions
	const abortController = new AbortController();
	extMgr.startAll(abortController.signal).catch((err) => {
		logger.error({ err }, "extension start failed");
	});

	// 9. HTTP server
	const { Hono } = await import("hono");

	const app = new Hono();

	app.get("/health", (c) => {
		return c.json({
			status: "ok",
			extensions: enabledExtensions(config),
			agents: Array.from(resolvedAgents.keys()),
			tools: globalRegistry.list().length,
		});
	});

	// Webhook endpoint for extensions
	app.post("/webhook/:extension", async (c) => {
		const extName = c.req.param("extension");
		logger.info({ extension: extName }, "webhook received");
		return c.json({ received: true });
	});

	const port = parseInt(process.env.BELUGA_PORT ?? "8080");
	Bun.serve({ fetch: app.fetch, port });

	logger.info({ port }, "HTTP server started");

	// 10. Graceful shutdown
	const shutdown = async () => {
		logger.info("shutting down...");

		abortController.abort();
		await extMgr.stopAll();
		await workspaceManager.close();
		await pgClient.end();

		process.exit(0);
	};

	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

/** Check if an agent is enabled in config. */
function isAgentEnabled(
	config: { agents: Record<string, { enabled?: boolean }> },
	name: string,
): boolean {
	const entry = config.agents[name];
	// If not in config at all, default to enabled
	if (!entry) return true;
	return entry.enabled !== false;
}

// ── Onboard command ───────────────────────────────────────────

async function onboardCommand(): Promise<void> {
	const belugaDir = ".beluga";
	mkdirSync(join(belugaDir, "prompts"), { recursive: true });
	mkdirSync(join(belugaDir, "extensions"), { recursive: true });
	mkdirSync(join(belugaDir, "agents", "default"), { recursive: true });

	// Config
	const configPath = join(belugaDir, "config.json");
	if (!existsSync(configPath)) {
		const defaultConfig = {
			llm: {
				endpoint: "${LLM_ENDPOINT}",
				apiKey: "${LLM_API_KEY}",
				model: "${LLM_MODEL}",
			},
			database: {
				host: "localhost",
				port: 5432,
				name: "beluga",
				user: "beluga",
				password: "${BELUGA_DB_PASSWORD:-beluga}",
				sslmode: "disable",
				maxConnections: 20,
			},
			workspace: {
				dockerHost: "",
				agentImage: "ubuntu:24.04",
				cpuLimit: "1.0",
				memoryLimit: "1g",
				idleTimeout: "1h",
				networkMode: "none",
			},
			agent: {
				maxIterations: 30,
				maxContextTokens: 128000,
			},
			extensions: {},
			agents: {
				default: { enabled: true },
			},
			routing: {
				_default: "default",
			},
		};
		writeFileSync(
			configPath,
			JSON.stringify(defaultConfig, null, 2) + "\n",
		);
		console.log(`✓ created ${configPath}`);
	} else {
		console.log(`${configPath} already exists`);
	}

	// Default system prompt (legacy location for backward compat)
	const promptPath = join(belugaDir, "prompts", "SYSTEM.md");
	if (!existsSync(promptPath)) {
		writeFileSync(
			promptPath,
			`# Beluga Agent

You are Beluga, an AI agent that helps users manage tasks and projects.
You have access to tools in a workspace sandbox and can interact with external services via extensions.
Always respond concisely and accurately.
`,
		);
		console.log(`✓ created ${promptPath}`);
	}

	// Default agent manifest
	const defaultAgentManifest = join(
		belugaDir,
		"agents",
		"default",
		"agent.json",
	);
	if (!existsSync(defaultAgentManifest)) {
		writeFileSync(
			defaultAgentManifest,
			JSON.stringify(
				{
					name: "default",
					version: "0.1.0",
					description: "Default Beluga agent",
					systemPrompt: "../../prompts/SYSTEM.md",
					extensions: [],
				},
				null,
				2,
			) + "\n",
		);
		console.log(`✓ created ${defaultAgentManifest}`);
	}

	console.log("\n✓ onboarded. Edit .beluga/config.json with your settings.");
}

// ── CLI ───────────────────────────────────────────────────────

const program = new Command();

program
	.name("beluga")
	.description("Beluga — AI agent orchestrator")
	.version("0.1.0");

program
	.command("start")
	.description("Start the Beluga daemon")
	.option("-c, --config <path>", "config file path", ".beluga/config.json")
	.action(async (opts) => {
		await startCommand(resolve(opts.config));
	});

program
	.command("onboard")
	.description("Initialize Beluga configuration")
	.action(async () => {
		await onboardCommand();
	});

program
	.command("status")
	.description("Show Beluga status")
	.action(async () => {
		console.log("Beluga status: not yet implemented");
	});

// ── Extend subcommands ────────────────────────────────────────

const extendCmd = program
	.command("extend")
	.description("Manage extensions");

extendCmd
	.command("install <source>")
	.description("Install an extension from a git URL or local path")
	.option("-t, --type <type>", "extension type (local or remote)")
	.action(async (source, opts) => {
		await installExtension({
			source,
			type: opts.type,
			belugaDir: process.cwd(),
		});
	});

extendCmd
	.command("create <name>")
	.description("Scaffold a new extension")
	.option("-t, --type <type>", "extension type", "local")
	.option("-o, --out <dir>", "output directory", ".")
	.action(async (name, opts) => {
		scaffoldExtension({ name, type: opts.type, outDir: opts.out });
	});

extendCmd
	.command("verify <path>")
	.description("Verify an extension")
	.action(async (path) => {
		const result = await verifyExtension(path);
		printVerifyResult(result);
		if (!result.compiles) process.exit(1);
	});

// ── Agent subcommands ─────────────────────────────────────────

const agentCmd = program.command("agent").description("Manage agents");

agentCmd
	.command("install <source>")
	.description("Install an agent from a git URL or local path")
	.action(async (source) => {
		await installAgent({ source, belugaDir: process.cwd() });
	});

agentCmd
	.command("create <name>")
	.description("Scaffold a new agent")
	.option("--from <agent>", "copy an existing agent's config as a template")
	.option("-o, --out <dir>", "output directory", ".beluga/agents")
	.action(async (name, opts) => {
		scaffoldAgent({
			name,
			from: opts.from,
			outDir: opts.out,
		});
	});

agentCmd
	.command("verify <path>")
	.description("Verify an agent")
	.action(async (path) => {
		const result = await verifyAgent(path);
		const name = path.split("/").pop() ?? path;
		printAgentVerifyResult(name, result);
		if (!result.valid) process.exit(1);
	});

agentCmd
	.command("list")
	.description("List installed agents")
	.action(async () => {
		listAgents(process.cwd());
	});

program.parse();
