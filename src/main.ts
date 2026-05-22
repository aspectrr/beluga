// ── Beluga main entry point ───────────────────────────────────
// Ported from cmd/beluga/main.go

import { Command } from "commander";
import pino from "pino";
import { resolve, join } from "path";
import { readFileSync, existsSync } from "fs";

// Core
import { loadConfig, enabledExtensions, extensionRawConfig } from "./core/config/config.js";
import { createPool } from "./core/database/pool.js";
import { ExtDB, defaultExtPermissions } from "./core/database/extdb.js";
import { EventStore } from "./core/eventstore/store.js";
import { SessionStore } from "./core/session/store.js";
import { Registry, registerWorkspaceTools } from "./core/tools/index.js";
import { WorkspaceManager } from "./core/workspace/manager.js";
import { ExtensionManager, loadRuntimeExtensions } from "./core/extension/index.js";
import { LLMClient } from "./core/agent/llm.js";
import { ContextBuilder } from "./core/agent/context.js";
import { Compactor } from "./core/agent/compactor.js";
import { Orchestrator, type ToolExecutor } from "./core/agent/loop.js";

// CLI
import { installExtension } from "./cli/extend/install.js";
import { scaffoldExtension } from "./cli/extend/scaffold.js";
import { verifyExtension, printVerifyResult } from "./cli/extend/verify.js";

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
    sessionId: string
  ): Promise<Record<string, unknown>> {
    const sandbox = this.workspaceManager.get(sessionId) ?? null;
    return this.registry.execute(name, args, {
      sessionId,
      sandbox,
      eventStore: null,
    });
  }
}

// ── All extensions are loaded at runtime from .beluga/extensions/ ──
// Drop an extension.json + index.ts into .beluga/extensions/{name}/
// and it will be auto-discovered and loaded on startup.

// ── Start command ─────────────────────────────────────────────

async function startCommand(configPath: string): Promise<void> {
  logger.info("starting Beluga");

  // 1. Load config
  const config = loadConfig(configPath);
  logger.info({ extensions: enabledExtensions(config) }, "config loaded");

  // 2. Database
  const { db, client: pgClient } = createPool(config.database);
  logger.info("database connected");

  // 3. Stores
  const sessionStore = new SessionStore(db);
  const eventStore = new EventStore(db);

  // 4. Tools
  const registry = new Registry();
  registerWorkspaceTools(registry);
  logger.info({ count: registry.list().length }, "tools registered");

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
    logger
  );

  // 6. Assemble system prompt
  let systemPrompt = "";
  const promptsDir = resolve(configPath, "../prompts");
  const systemMd = join(promptsDir, "SYSTEM.md");
  if (existsSync(systemMd)) {
    systemPrompt = readFileSync(systemMd, "utf-8");
  }

  // 7. LLM client
  const llm = new LLMClient(config.llm, logger);

  // 8. Agent orchestration
  const contextBuilder = new ContextBuilder(systemPrompt || undefined);
  contextBuilder.setMaxTokens(config.agent.maxContextTokens);
  const compactor = new Compactor(eventStore, llm, contextBuilder, logger);
  const toolExecutor = new ToolExecutorAdapter(registry, workspaceManager);
  const orchestrator = new Orchestrator(
    sessionStore,
    eventStore,
    llm,
    toolExecutor,
    contextBuilder,
    compactor,
    config.agent.maxIterations,
    logger
  );

  // Wire tool definitions
  orchestrator.setTools(registry.list());

  // Helper: create session from extension context
  const createSession = async (
    source: string,
    sourceId: string,
    initialMessage: string,
    metadata?: Record<string, unknown>
  ) => {
    return orchestrator.handleNewSession(source, sourceId, initialMessage, metadata);
  };

  // 9. Extension manager — loads from .beluga/extensions/
  const shared: Record<string, unknown> = {};
  const extMgr = new ExtensionManager(logger);
  const runtimeExtDir = resolve(configPath, "../extensions");

  await loadRuntimeExtensions(
    runtimeExtDir,
    extMgr,
    (name: string) => ({
      config: extensionRawConfig(config, name),
      registry,
      sessions: sessionStore,
      events: eventStore,
      db: new ExtDB(db, name, defaultExtPermissions(name)),
      logger: logger.child({ extension: name }),
      promptDir: promptsDir,
      createSession,
      shared,
    }),
    logger
  );

  // Initialize extensions
  await extMgr.initAll();
  logger.info({ count: enabledExtensions(config).length }, "extensions initialized");

  // Refresh orchestrator tools after extensions registered theirs
  orchestrator.setTools(registry.list());
  logger.info({ count: registry.list().length }, "tools updated after extensions");

  // Start extensions
  const abortController = new AbortController();
  extMgr.startAll(abortController.signal).catch((err) => {
    logger.error({ err }, "extension start failed");
  });

  // 10. HTTP server
  const { Hono } = await import("hono");

  const app = new Hono();

  app.get("/health", (c) => {
    return c.json({
      status: "ok",
      extensions: enabledExtensions(config),
      tools: registry.list().length,
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

  // 11. Graceful shutdown
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

// ── Onboard command ───────────────────────────────────────────

async function onboardCommand(): Promise<void> {
  const { mkdirSync, writeFileSync } = await import("fs");

  const belugaDir = ".beluga";
  mkdirSync(join(belugaDir, "prompts"), { recursive: true });
  mkdirSync(join(belugaDir, "extensions"), { recursive: true });

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
    };
    writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2) + "\n");
    console.log(`✓ created ${configPath}`);
  } else {
    console.log(`${configPath} already exists`);
  }

  // Write default system prompt
  const promptPath = join(belugaDir, "prompts", "SYSTEM.md");
  if (!existsSync(promptPath)) {
    writeFileSync(
      promptPath,
      `# Beluga Agent

You are Beluga, an AI agent that helps users manage tasks and projects.
You have access to tools in a workspace sandbox and can interact with external services via extensions.
Always respond concisely and accurately.
`
    );
    console.log(`✓ created ${promptPath}`);
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

// Extend subcommands
const extendCmd = program.command("extend").description("Manage extensions");

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

program.parse();
