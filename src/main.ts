// ── Beluga main entry point ───────────────────────────────────
// Ported from cmd/beluga/main.go

import { Command } from "commander";
import pino, { type Logger } from "pino";
import { resolve, join } from "path";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";

// Core
import {
  loadConfig,
  type Config,
  isExtensionEnabled,
  enabledExtensions,
  extensionRawConfig,
  enabledAgents,
  resolveRouting,
  resolveAgentLLM,
} from "./core/config/config.js";
import { createPool } from "./core/database/pool.js";
import { runMigrations } from "./core/database/migrate.js";
import { ExtDB, defaultExtPermissions } from "./core/database/extdb.js";
import { EventStore } from "./core/eventstore/store.js";
import { SessionStore } from "./core/session/store.js";
import { Registry, registerWorkspaceTools } from "./core/tools/index.js";
import { registerPublishTools } from "./core/tools/publish.js";
import { registerSkillTools } from "./core/tools/skills.js";
import { WorkspaceManager, ContainerNotRunningError } from "./core/workspace/manager.js";
import {
  ExtensionManager,
  loadRuntimeExtensions,
} from "./core/extension/index.js";
import { LLMClient, detectContextWindow } from "./core/agent/llm.js";
import { ContextBuilder } from "./core/agent/context.js";
import { Compactor } from "./core/agent/compactor.js";
import { Orchestrator, type ToolExecutor } from "./core/agent/loop.js";
import { SessionRouter } from "./core/agent/router.js";
import { AgentRunner, type SkillIndex } from "./core/agent/runner.js";
import { loadAgents, type LoadedAgent } from "./core/agent/loader.js";
import type { ResolvedAgent } from "@aspectrr/beluga-sdk";
import { ProviderModelCache } from "./core/model/cache.js";

// CLI
import { installExtension } from "./cli/extend/install.js";
import { scaffoldExtension } from "./cli/extend/scaffold.js";
import { verifyExtension, printVerifyResult } from "./cli/extend/verify.js";
import { installAgent } from "./cli/agent/install.js";
import { scaffoldAgent } from "./cli/agent/scaffold.js";
import { verifyAgent, printAgentVerifyResult } from "./cli/agent/verify.js";
import { listAgents } from "./cli/agent/list.js";
import { removeAgent } from "./cli/agent/remove.js";
import { buildWorkspace } from "./core/workspace/builder.js";

const logger = pino({
  level: process.env.LOG_LEVEL || "debug",
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
  private logger: Logger;
  agent: string;

  constructor(
    registry: Registry,
    workspaceManager: WorkspaceManager,
    agent: string,
    logger: Logger,
  ) {
    this.registry = registry;
    this.workspaceManager = workspaceManager;
    this.agent = agent;
    this.logger = logger;
  }

  async executeTool(
    name: string,
    args: Record<string, unknown>,
    sessionId: string,
  ): Promise<Record<string, unknown>> {
    let sandbox = this.workspaceManager.get(sessionId) ?? null;

    this.logger.debug({ sessionId, tool: name, hasSandbox: !!sandbox }, "executeTool: checking sandbox");

    // Auto-create sandbox for any tool call (triggers onWorkspaceReady hooks)
    if (!sandbox) {
      this.logger.debug({ sessionId, tool: name }, "executeTool: creating workspace");
      sandbox = await this.workspaceManager.create(sessionId);
      this.logger.debug({ sessionId, tool: name, created: !!sandbox }, "executeTool: workspace created");
    }

    try {
      return await this.registry.execute(name, args, {
        sessionId,
        sandbox,
        eventStore: null,
        agent: this.agent,
      });
    } catch (err) {
      // If the container died mid-session, remove stale ref and let
      // create() recover — the Docker volume preserves all workspace data.
      if (err instanceof ContainerNotRunningError) {
        this.logger.warn(
          { sessionId, tool: name, containerId: sandbox?.id },
          "container not running, removing stale ref and recovering",
        );
        // Remove stale in-memory ref (don't destroy — volume must survive)
        this.workspaceManager.removeSandboxRef(sessionId);
        // create() will find the volume and create a fresh container with it
        sandbox = await this.workspaceManager.create(sessionId);
        return await this.registry.execute(name, args, {
          sessionId,
          sandbox,
          eventStore: null,
          agent: this.agent,
        });
      }
      throw err;
    }
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

  // 2.1. Run migrations (create tables if not exist)
  await runMigrations(db);
  logger.info("database migrations complete");

  // 2.5. Provider model cache — polls /models endpoints
  const modelCache = new ProviderModelCache(config.providers, logger);
  modelCache.start();

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
      retentionTimeout: config.workspace.retentionTimeout,
      cpuLimit: config.workspace.cpuLimit,
      memoryLimit: config.workspace.memoryLimit,
      networkMode: config.workspace.networkMode,
    },
    logger,
  );

  // 5.1. Recover workspace containers from previous daemon runs
  await workspaceManager.recoverFromDocker();

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
  const agentSkills = new Map<string, SkillIndex[]>();

  for (const loaded of loadedAgents) {
    if (!isAgentEnabled(config, loaded.name)) {
      logger.info({ agent: loaded.name }, "agent disabled, skipping");
      continue;
    }
    const { agent: resolved, skills } = await agentRunner.resolve(loaded.manifest, loaded.dir);
    resolvedAgents.set(loaded.name, resolved);
    agentSkills.set(loaded.name, skills);
    logger.info(
      {
        agent: resolved.name,
        extensions: resolved.extensions,
        model: resolved.model.model,
        skills: skills.map((s) => s.name),
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
  async function getOrchestrator(
    agentName: string,
  ): Promise<AgentOrchestrator | null> {
    const existing = agentOrchestrators.get(agentName);
    if (existing) return existing;

    const resolved = resolvedAgents.get(agentName);
    if (!resolved) {
      logger.error({ agent: agentName }, "no resolved agent found");
      return null;
    }

    // Build per-agent LLM client (model already fully resolved from provider)
    const agentLlm = new LLMClient(
      {
        endpoint: resolved.model.endpoint,
        apiKey: resolved.model.apiKey,
        model: resolved.model.model,
        embeddingModel: resolved.model.embeddingModel,
        embeddingDimensions: resolved.model.embeddingDimensions,
      },
      logger,
    );

    // Build per-agent context builder
    const contextBuilder = new ContextBuilder(
      resolved.systemPrompt || undefined,
    );

    // Auto-detect context window from model name
    const contextWindow =
      resolved.maxContextTokens || (await detectContextWindow(resolved.model.model));
    contextBuilder.setMaxTokens(contextWindow);

    // Build per-agent tool registry — filtered to this agent's extensions
    const agentRegistry = new Registry();
    registerWorkspaceTools(agentRegistry);

    // Add skill loading tool for this agent
    const skills = agentSkills.get(agentName) ?? [];
    registerSkillTools(agentRegistry, skills);

    if (skills.length > 0) {
      logger.info(
        { agent: agentName, skills: skills.map((s) => s.name) },
        "registered skill tool with available skills",
      );
    }

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
        toolDef.name.startsWith("publish_") ||
        toolDef.name.startsWith("load_")
      ) {
        continue;
      }

      // Check if this tool was registered by an extension this agent uses
      const source = globalRegistry.getSource(toolDef.name);
      if (
        (source && resolved.extensions.includes(source)) ||
        resolved.extensions.length === 0
      ) {
        const tool = globalRegistry.get(toolDef.name);
        if (tool) agentRegistry.register(tool);
      }
    }

    // Build orchestrator
    const compactor = new Compactor(
      eventStore,
      agentLlm,
      contextBuilder,
      logger,
      {
        contextWindow,
      },
    );
    const toolExecutor = new ToolExecutorAdapter(
      agentRegistry,
      workspaceManager,
      resolved.name,
      logger.child({ agent: agentName }),
    );
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
        tools: agentRegistry.list().map((t) => t.name),
        model: resolved.model.model,
        contextWindow,
        maxIterations: resolved.maxIterations || Infinity,
        skills: skills.map((s) => s.name),
      },
      "orchestrator built for agent",
    );

    return entry;
  }

  // Build router
  const router = new SessionRouter(config, logger);

  // Session creation — routes to the correct agent
  const cancelSession = async (
    sessionId: string,
  ): Promise<boolean> => {
    const session = await sessionStore.get(sessionId);
    if (!session) throw new Error(`session not found: ${sessionId}`);
    const agentName =
      (session?.metadata?.agent as string) ?? router.resolve("default");
    const entry = await getOrchestrator(agentName);
    if (!entry) throw new Error(`no orchestrator for agent: ${agentName}`);
    return entry.orchestrator.cancel(sessionId);
  };

  const createSession = async (
    source: string,
    sourceId: string,
    initialMessage: string,
    metadata?: Record<string, unknown>,
  ) => {
    const agentName = router.resolve(source, sourceId);
    logger.info({ source, sourceId, agent: agentName }, "session routed");

    const entry = await getOrchestrator(agentName);
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
    const entry = await getOrchestrator(agentName);
    if (!entry) {
      throw new Error(`no orchestrator for agent: ${agentName}`);
    }
    return entry.orchestrator.handleContinueSession(
      sessionId,
      message,
      metadata,
    );
  };

  await loadRuntimeExtensions(
    runtimeExtDir,
    extMgr,
    (name: string) => ({
      config: extensionRawConfig(config, name),
      instanceName: name,
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
    (name: string) => isExtensionEnabled(config, name),
    () => config,
  );

  // Initialize extensions
  await extMgr.initAll();
  logger.info(
    { count: enabledExtensions(config).length },
    "extensions initialized",
  );

  // Wire extension manager into workspace manager for onWorkspaceReady hooks
  workspaceManager.setExtensionManager(extMgr);

  // Pre-build orchestrators for all enabled agents
  for (const agentName of resolvedAgents.keys()) {
    await getOrchestrator(agentName);
  }

  // Start extensions
  const abortController = new AbortController();
  extMgr.startAll(abortController.signal).catch((err) => {
    logger.error({ err }, "extension start failed");
  });

  // 9. HTTP server
  const { Hono } = await import("hono");
  const { streamSSE } = await import("hono/streaming");
  const { readFileSync: readStatic, existsSync: existsStatic, readdirSync } = await import("fs");

  const app = new Hono();

  // ── Health ──────────────────────────────────────────────────

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

  // ── API: Providers ──────────────────────────────────────────

  app.get("/api/providers", (c) => {
    const list = Object.entries(config.providers).map(([name, p]) => ({
      name,
      endpoint: p.endpoint,
      apiKey: p.apiKey ? "••••••" : "", // never expose keys
      model: p.model,
      embeddingModel: p.embeddingModel,
      embeddingDimensions: p.embeddingDimensions,
    }));
    return c.json(list);
  });

  app.put("/api/providers/:name", async (c) => {
    const name = c.req.param("name");
    const body = await c.req.json();
    config.providers[name] = {
      endpoint: String(body.endpoint ?? ""),
      apiKey: String(body.apiKey ?? ""),
      model: String(body.model ?? ""),
      embeddingModel: body.embeddingModel ? String(body.embeddingModel) : undefined,
      embeddingDimensions: body.embeddingDimensions ? Number(body.embeddingDimensions) : undefined,
    };
    modelCache.setProvider(name, config.providers[name]);
    // Persist to config.json
    await persistConfig(configPath, config);
    return c.json({ name, ...config.providers[name] });
  });

  app.delete("/api/providers/:name", async (c) => {
    const name = c.req.param("name");
    delete config.providers[name];
    modelCache.removeProvider(name);
    await persistConfig(configPath, config);
    return c.json({ deleted: true });
  });

  // ── API: Provider Models ────────────────────────────────────

  app.get("/api/providers/:name/models", async (c) => {
    const name = c.req.param("name");
    const models = modelCache.getModels(name);
    // Auto-refresh if empty or stale
    if (models.length === 0) {
      const refreshed = await modelCache.refresh(name);
      return c.json(refreshed);
    }
    return c.json(models);
  });

  app.get("/api/models", (c) => {
    return c.json(modelCache.getAllModels());
  });

  // ── API: Agents ─────────────────────────────────────────────

  app.get("/api/agents", (c) => {
    const allAgents = Array.from(resolvedAgents.values());
    return c.json(allAgents.map(a => {
      const agentEntry = config.agents[a.name] as Record<string, unknown> | undefined;
      const modelOverride = agentEntry?.model as string | undefined;
      return {
        name: a.name,
        enabled: isAgentEnabled(config, a.name),
        provider: agentEntry?.provider as string | null ?? null,
        model: modelOverride || a.model.model,
        extensions: a.extensions,
        maxIterations: a.maxIterations || Infinity,
      };
    }));
  });

  app.get("/api/agents/:name", (c) => {
    const name = c.req.param("name");
    const resolved = resolvedAgents.get(name);
    if (!resolved) return c.json({ error: "agent not found" }, 404);
    const agentEntry = config.agents[name] as Record<string, unknown> | undefined;
    const modelOverride = agentEntry?.model as string | undefined;
    return c.json({
      name: resolved.name,
      enabled: isAgentEnabled(config, resolved.name),
      provider: agentEntry?.provider as string | null ?? null,
      model: modelOverride || resolved.model.model,
      extensions: resolved.extensions,
      maxIterations: resolved.maxIterations || Infinity,
    });
  });

  app.put("/api/agents/:name", async (c) => {
    const name = c.req.param("name");
    const body = await c.req.json();
    if (!config.agents[name]) {
      config.agents[name] = { enabled: true };
    }
    const entry = config.agents[name] as Record<string, unknown>;
    if (body.enabled !== undefined) entry.enabled = body.enabled;
    if (body.provider !== undefined) entry.provider = body.provider || undefined;
    if (body.model !== undefined) entry.model = body.model || undefined;

    // Re-resolve the agent's LLM config so runtime picks up changes
    const resolved = resolvedAgents.get(name);
    if (resolved) {
      const llm = resolveAgentLLM(config, name);
      resolved.model = {
        endpoint: llm.endpoint,
        apiKey: llm.apiKey,
        model: llm.model,
        embeddingModel: llm.embeddingModel,
        embeddingDimensions: llm.embeddingDimensions,
      };
      // Rebuild orchestrator so next session uses new model
      agentOrchestrators.delete(name);
    }

    await persistConfig(configPath, config);
    const agentEntry = config.agents[name] as Record<string, unknown> | undefined;
    const modelOverride = agentEntry?.model as string | undefined;
    return c.json({
      name,
      enabled: entry.enabled,
      provider: entry.provider ?? null,
      model: modelOverride || resolved?.model.model || null,
    });
  });

  // ── API: Sessions ──────────────────────────────────────────

  app.get("/api/sessions", async (c) => {
    const limit = parseInt(c.req.query("limit") ?? "50");
    // Get all recent sessions — try completed, then running, then pending
    const [completed, running, pending] = await Promise.all([
      sessionStore.listByStatus("completed", limit),
      sessionStore.listByStatus("running", limit),
      sessionStore.listByStatus("pending", limit),
    ]);
    const all = [...running, ...pending, ...completed].slice(0, limit);
    return c.json(all.map(s => ({
      id: s.id,
      source: s.source,
      sourceId: s.sourceId,
      agent: s.agent,
      status: s.status,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    })));
  });

  app.post("/api/sessions", async (c) => {
    const body = await c.req.json();
    const source = String(body.source ?? "chat");
    const sourceId = String(body.sourceId ?? crypto.randomUUID());
    const message = String(body.message ?? "");
    const agent = body.agent ? String(body.agent) : undefined;

    // Override routing if agent specified
    if (agent) {
      const session = await createSession(source, sourceId, message, { agent });
      return c.json(session);
    }
    const session = await createSession(source, sourceId, message);
    return c.json({
      id: session.id,
      source: session.source,
      sourceId: session.sourceId,
      agent: session.agent,
      status: session.status,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    });
  });

  app.post("/api/sessions/:id/cancel", async (c) => {
    const sessionId = c.req.param("id");
    try {
      const cancelled = await cancelSession(sessionId);
      return c.json({ cancelled });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Unknown error" }, 400);
    }
  });

  app.post("/api/sessions/:id/messages", async (c) => {
    const sessionId = c.req.param("id");
    const body = await c.req.json();
    const message = String(body.message ?? "");
    const session = await continueSession(sessionId, message);
    return c.json({
      id: session.id,
      status: session.status,
    });
  });

  // ── API: Events ────────────────────────────────────────────

  app.get("/api/sessions/:id/events", async (c) => {
    const sessionId = c.req.param("id");
    const events_list = await eventStore.getEvents(sessionId, 0, 10000);
    return c.json(events_list.map(e => ({
      id: e.id,
      sessionId: e.sessionId,
      seq: e.seq,
      type: e.type,
      data: e.data,
      createdAt: e.createdAt,
    })));
  });

  // SSE stream for live events
  app.get("/api/sessions/:id/events/stream", async (c) => {
    const sessionId = c.req.param("id");
    const afterSeq = parseInt(c.req.query("afterSeq") ?? "0");

    return streamSSE(c, async (stream) => {
      // Send existing events first
      const existing = await eventStore.getEvents(sessionId, afterSeq, 10000);
      for (const evt of existing) {
        await stream.writeSSE({
          event: "event",
          data: JSON.stringify({
            id: evt.id,
            sessionId: evt.sessionId,
            seq: evt.seq,
            type: evt.type,
            data: evt.data,
            createdAt: evt.createdAt,
          }),
        });
      }

      // Stream live events
      const watcher = (event: any) => {
        stream.writeSSE({
          event: "event",
          data: JSON.stringify({
            id: event.id,
            sessionId: event.sessionId,
            seq: event.seq,
            type: event.type,
            data: event.data,
            createdAt: event.createdAt,
          }),
        }).catch(() => {});
      };

      eventStore["addWatcher"](sessionId, watcher);

      // Keep connection alive
      const keepAlive = setInterval(() => {
        stream.writeSSE({ event: "ping", data: "" }).catch(() => {});
      }, 15000);

      // Wait for abort
      await new Promise<void>((resolve) => {
        c.req.raw.signal.addEventListener("abort", () => resolve(), { once: true });
      });

      clearInterval(keepAlive);
      eventStore["removeWatcher"](sessionId, watcher);
    });
  });

  // ── Static UI ─────────────────────────────────────────────

  const uiDist = resolve(process.cwd(), "ui/dist");
  if (existsStatic(uiDist)) {
    // Serve built React app
    app.get("/*", async (c) => {
      const urlPath = c.req.path;
      // Try exact file first
      const filePath = resolve(uiDist, urlPath.slice(1) || "index.html");
      if (existsStatic(filePath) && filePath.startsWith(uiDist)) {
        const file = Bun.file(filePath);
        return new Response(file);
      }
      // SPA fallback
      const indexFile = Bun.file(resolve(uiDist, "index.html"));
      return new Response(indexFile);
    });
    logger.info({ dir: uiDist }, "serving UI");
  }

  const port = parseInt(process.env.BELUGA_PORT ?? "8080");
  Bun.serve({ fetch: app.fetch, port });

  logger.info({ port }, "HTTP server started");

  // 10. Graceful shutdown
  const shutdown = async () => {
    logger.info("shutting down...");

    modelCache.stop();
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

/** Persist runtime config back to disk. */
async function persistConfig(configPath: string, config: Config): Promise<void> {
  // Build a serializable version — expose providers with real keys for save
  const serializable = {
    llm: config.llm,
    providers: config.providers,
    database: config.database,
    workspace: {
      dockerHost: config.workspace.dockerHost,
      agentImage: config.workspace.agentImage,
      cpuLimit: config.workspace.cpuLimit,
      memoryLimit: config.workspace.memoryLimit,
      idleTimeout: `${config.workspace.idleTimeout / 3600}h`,
      retentionTimeout: `${Math.round(config.workspace.retentionTimeout / 86400)}d`,
      networkMode: config.workspace.networkMode,
    },
    extensions: config.extensions,
    agents: config.agents,
    routing: config.routing,
  };

  try {
    writeFileSync(configPath, JSON.stringify(serializable, null, 2) + "\n");
  } catch (err: any) {
    if (err?.code === "EROFS" || err?.code === "EACCES") {
      // Config mount is read-only — write to data dir overlay instead
      const dataDir = process.env.BELUGA_DATA_DIR ?? "/var/lib/beluga";
      mkdirSync(dataDir, { recursive: true });
      const overlayPath = join(dataDir, "config.json");
      writeFileSync(overlayPath, JSON.stringify(serializable, null, 2) + "\n");
      logger.warn({ overlayPath }, "config mount read-only, wrote to data overlay");
    } else {
      throw err;
    }
  }
}

// ── Onboard command ───────────────────────────────────────────

async function onboardCommand(): Promise<void> {
  const belugaDir = ".beluga";
  mkdirSync(join(belugaDir, "prompts"), { recursive: true });
  mkdirSync(join(belugaDir, "extensions"), { recursive: true });
  mkdirSync(join(belugaDir, "agents", "default", "skills"), { recursive: true });

  // Config
  const configPath = join(belugaDir, "config.json");
  if (!existsSync(configPath)) {
    const defaultConfig = {
      llm: {
        endpoint: "${LLM_ENDPOINT}",
        apiKey: "${LLM_API_KEY}",
        model: "${LLM_MODEL}",
      },
      providers: {},
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
        agentImage: "beluga/agent-workspace:latest",
        cpuLimit: "1.0",
        memoryLimit: "1g",
        idleTimeout: "1h",
        networkMode: "none",
      },
      extensions: {},
      agents: {
        default: { enabled: true },
      },
      routing: {
        _default: "default",
      },
    };
    writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2) + "\n");
    console.log(`✓ created ${configPath}`);
  } else {
    console.log(`${configPath} already exists`);
  }

  // Default system prompt template (used as base for new agents)
  const promptPath = join(belugaDir, "prompts", "SYSTEM.md");
  const systemPromptContent = `# Beluga Agent

You are Beluga, an AI agent that helps users manage tasks and projects.
You have access to tools in a workspace sandbox and can interact with external services via extensions.
Always respond concisely and accurately.

## Skills

Check the Available Skills section below. When a user's task matches a skill, call \`load_skill\` with that skill's name BEFORE taking any other action. Follow the skill's instructions exactly — they contain site-specific workflows and pitfall avoidance.
`;

  if (!existsSync(promptPath)) {
    writeFileSync(promptPath, systemPromptContent);
    console.log(`✓ created ${promptPath}`);
  }

  // Default agent manifest
  const defaultAgentDir = join(belugaDir, "agents", "default");
  const defaultAgentManifest = join(defaultAgentDir, "agent.json");
  if (!existsSync(defaultAgentManifest)) {
    // Clone system prompt into agent directory
    const agentPromptPath = join(defaultAgentDir, "SYSTEM.md");
    if (!existsSync(agentPromptPath)) {
      writeFileSync(agentPromptPath, systemPromptContent);
      console.log(`✓ created ${agentPromptPath}`);
    }

    writeFileSync(
      defaultAgentManifest,
      JSON.stringify(
        {
          name: "default",
          version: "0.1.0",
          description: "Default Beluga agent",
          systemPrompt: "SYSTEM.md",
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

agentCmd
  .command("remove <name>")
  .description("Remove an installed agent")
  .action(async (name) => {
    removeAgent(name, process.cwd());
  });

// ── Workspace subcommands ─────────────────────────────────────

const workspaceCmd = program
  .command("workspace")
  .description("Manage workspace images");

workspaceCmd
  .command("build")
  .description("Build workspace image with packages from all extensions")
  .option("-c, --config <path>", "config file path", ".beluga/config.json")
  .option("--force", "rebuild even if unchanged", false)
  .option("--base-image <image>", "base image name", "beluga/agent-workspace:latest")
  .option("--output-image <image>", "output image name")
  .action(async (opts) => {
    const configPath = resolve(opts.config);
    const belugaDir = resolve(configPath, "..");
    const baseImage = opts.baseImage;
    const outputImage = opts.outputImage ?? baseImage;
    const baseDockerfile = resolve(belugaDir, "..", "workspace.Dockerfile");

    try {
      const result = await buildWorkspace(
        {
          belugaDir,
          baseImage,
          outputImage,
          baseDockerfile,
        },
        logger,
        { force: opts.force },
      );

      if (result.built) {
        console.log(`✓ workspace image built: ${result.image} (fingerprint: ${result.fingerprint})`);
      } else {
        console.log(`✓ workspace image up to date: ${result.image}`);
      }
    } catch (err) {
      console.error(`✗ build failed: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

program.parse();
