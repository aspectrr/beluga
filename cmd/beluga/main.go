// beluga is the main Beluga daemon.
// It manages agent sessions, Docker sandbox workspaces, and orchestrates
// the agent runtime. Extensions add capabilities like connectors and tools.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/collinpfeifer/beluga/internal/core/agent"
	"github.com/collinpfeifer/beluga/internal/core/config"
	"github.com/collinpfeifer/beluga/internal/core/database"
	"github.com/collinpfeifer/beluga/internal/core/eventstore"
	"github.com/collinpfeifer/beluga/internal/core/extension"
	"github.com/collinpfeifer/beluga/internal/core/session"
	"github.com/collinpfeifer/beluga/internal/core/tools"
	"github.com/collinpfeifer/beluga/internal/core/workspace"
)

const defaultSystemPrompt = `You are Beluga, a managed agent. You work in a sandboxed workspace where you can read and write files and execute commands.

Be thorough but concise. Always explain what you're doing and why.
`

func main() {
	configPath := flag.String("config", "configs/beluga.yaml", "path to config file")
	belugaDir := flag.String("beluga-dir", ".beluga", "path to .beluga directory")
	flag.Parse()

	// Setup structured JSON logger.
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))
	slog.SetDefault(logger)

	logger.Info("beluga starting")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// ── Load config ───────────────────────────────────────────
	cfg, err := config.LoadConfig(*configPath)
	if err != nil {
		logger.Error("failed to load config", "error", err)
		os.Exit(1)
	}

	// ── Database ──────────────────────────────────────────────
	pool, err := database.NewPool(ctx, cfg.Database)
	if err != nil {
		logger.Error("failed to connect to database", "error", err)
		os.Exit(1)
	}
	defer pool.Close()
	logger.Info("database connected")

	// ── Stores ────────────────────────────────────────────────
	sessions := session.NewStore(pool)
	events := eventstore.NewStore(pool)

	// ── Tool registry ─────────────────────────────────────────
	registry := tools.NewRegistry()

	// Register built-in workspace tools (bash, read_file, edit_file).
	if err := tools.RegisterWorkspaceTools(registry); err != nil {
		logger.Error("failed to register workspace tools", "error", err)
		os.Exit(1)
	}

	// ── Workspace manager ─────────────────────────────────────
	workspaceMgr, err := workspace.NewManager(workspace.ManagerConfig{
		DockerHost:  cfg.Workspace.DockerHost,
		AgentImage:  cfg.Workspace.AgentImage,
		IdleTimeout: cfg.Workspace.IdleTimeout,
		CPULimit:    cfg.Workspace.CPULimit,
		MemoryLimit: cfg.Workspace.MemoryLimit,
	}, logger)
	if err != nil {
		logger.Error("failed to create workspace manager", "error", err)
		os.Exit(1)
	}

	// ── .beluga/ directory setup ──────────────────────────────
	promptDir := filepath.Join(*belugaDir, "prompts")
	skillsDir := filepath.Join(*belugaDir, "skills")
	systemPromptPath := filepath.Join(*belugaDir, "SYSTEM.md")

	os.MkdirAll(promptDir, 0o755)
	os.MkdirAll(skillsDir, 0o755)

	if _, err := os.Stat(systemPromptPath); os.IsNotExist(err) {
		if err := os.WriteFile(systemPromptPath, []byte(defaultSystemPrompt), 0o644); err != nil {
			logger.Error("failed to write default SYSTEM.md", "error", err)
			os.Exit(1)
		}
		logger.Info("wrote default SYSTEM.md", "path", systemPromptPath)
	}

	// ── Assemble system prompt ────────────────────────────────
	systemPrompt, err := assembleSystemPrompt(systemPromptPath, promptDir)
	if err != nil {
		logger.Error("failed to assemble system prompt", "error", err)
		os.Exit(1)
	}
	logger.Info("system prompt assembled",
		"system_md_len", len(systemPrompt),
		"prompts_dir", promptDir,
	)

	// ── LLM client ────────────────────────────────────────────
	llmClient := agent.NewLLMClient(cfg.LLM)

	// ── Tool executor adapter ─────────────────────────────────
	toolExec := &toolExecutorAdapter{
		registry:     registry,
		workspaceMgr: workspaceMgr,
	}

	// ── Orchestrator ──────────────────────────────────────────
	orchestratorInst := agent.NewWithPrompt(
		sessions,
		events,
		llmClient,
		toolExec,
		systemPrompt,
		logger,
	)

	// Wire tool definitions from the registry into the orchestrator.
	registryDefs := registry.List()
	orchTools := make([]agent.ToolDef, len(registryDefs))
	for i, td := range registryDefs {
		orchTools[i] = agent.ToolDef{
			Type: "function",
			Function: agent.FunctionDef{
				Name:        td.Name,
				Description: td.Description,
				Parameters:  td.Parameters,
			},
		}
	}
	orchestratorInst.SetTools(orchTools)

	if cfg.Agent.MaxContextTokens > 0 {
		// The context builder is internal to the orchestrator, so we set
		// max tokens via the agent config. For now this is wired through
		// the context builder's default of 128000.
	}

	logger.Info("tools registered", "count", len(registryDefs))

	// ── Extension manager ─────────────────────────────────────
	extMgr := extension.NewManager(logger)

	// Build the shared extension context template.
	extCtx := extension.ExtensionContext{
		Registry:      registry,
		Sessions:      sessions,
		Events:        events,
		DB:            pool,
		Docker:        nil, // workspace manager available via adapter if needed
		Logger:        logger,
		PromptDir:     promptDir,
		GRPC:          nil, // set by ext_host extension if enabled
		CreateSession: orchestratorInst.HandleNewSession,
	}

	// Register enabled extensions with their configs.
	// Phase 1 has no built-in extensions — this wires the infrastructure.
	for _, name := range cfg.EnabledExtensions() {
		rawCfg := cfg.ExtensionRawConfig(name)
		extCtxCopy := extCtx
		extCtxCopy.Config = rawCfg

		// Look up the extension in the built-in registry.
		// In Phase 1 there are none, so this is a no-op placeholder.
		if ext := lookupBuiltinExtension(name); ext != nil {
			extMgr.Register(ext, extCtxCopy)
		} else {
			logger.Warn("unknown extension, skipping", "name", name)
		}
	}

	// Initialize all extensions.
	if err := extMgr.InitAll(); err != nil {
		logger.Error("extension initialization failed", "error", err)
		os.Exit(1)
	}

	logger.Info("extensions initialized", "count", len(cfg.EnabledExtensions()))

	// ── Start extensions ──────────────────────────────────────
	if err := extMgr.StartAll(ctx); err != nil {
		logger.Error("extension start failed", "error", err)
		os.Exit(1)
	}

	// ── HTTP server (health + webhooks) ───────────────────────
	httpMux := http.NewServeMux()
	httpMux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(w, `{"status":"ok","tools":%d}`, len(registry.List()))
	})

	httpAddr := ":8080"
	httpServer := &http.Server{
		Addr:              httpAddr,
		Handler:           httpMux,
		ReadHeaderTimeout: 5 * time.Second,
	}

	go func() {
		logger.Info("HTTP server listening", "addr", httpAddr)
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Error("HTTP server error", "error", err)
		}
	}()

	logger.Info("beluga started successfully")

	// ── Wait for shutdown signal ──────────────────────────────
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	select {
	case sig := <-sigCh:
		logger.Info("received shutdown signal", "signal", sig)
	case <-ctx.Done():
		logger.Info("context cancelled")
	}

	// ── Graceful shutdown ─────────────────────────────────────
	logger.Info("beluga shutting down gracefully")

	// Stop extensions (reverse order).
	if err := extMgr.StopAll(ctx); err != nil {
		logger.Error("extension shutdown error", "error", err)
	}

	// Stop HTTP server.
	shutCtx, shutCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutCancel()
	if err := httpServer.Shutdown(shutCtx); err != nil {
		logger.Error("HTTP server shutdown error", "error", err)
	}

	// Cleanup workspaces.
	if err := workspaceMgr.Close(shutCtx); err != nil {
		logger.Error("workspace manager shutdown error", "error", err)
	}

	logger.Info("beluga shutdown complete")
}

// assembleSystemPrompt reads SYSTEM.md and appends any prompt templates from .beluga/prompts/.
func assembleSystemPrompt(systemPath, promptsDir string) (string, error) {
	data, err := os.ReadFile(systemPath)
	if err != nil {
		return "", fmt.Errorf("reading SYSTEM.md: %w", err)
	}
	prompt := string(data)

	// Append prompt templates from .beluga/prompts/*.md
	matches, err := filepath.Glob(filepath.Join(promptsDir, "*.md"))
	if err != nil {
		return "", fmt.Errorf("globbing prompts directory: %w", err)
	}

	for _, match := range matches {
		templateData, err := os.ReadFile(match)
		if err != nil {
			return "", fmt.Errorf("reading prompt template %s: %w", match, err)
		}
		content := strings.TrimSpace(string(templateData))
		if content != "" {
			name := filepath.Base(match)
			prompt += fmt.Sprintf("\n\n## %s\n\n%s", strings.TrimSuffix(name, ".md"), content)
		}
	}

	return prompt, nil
}

// lookupBuiltinExtension returns a built-in extension by name.
// Returns nil if no extension with that name is compiled in.
// Extensions are added here as they are implemented in later phases.
func lookupBuiltinExtension(name string) extension.Extension {
	// Phase 1: no built-in extensions.
	// Phase 3 will add: clickup, github, pipeline, evolving_skills, searchable_history
	// Phase 4 will add: ext_host, remora
	return nil
}

// mustJSON marshals v to JSON, returning an empty object on error.
func mustJSON(v interface{}) json.RawMessage {
	data, err := json.Marshal(v)
	if err != nil {
		return json.RawMessage(`{}`)
	}
	return json.RawMessage(data)
}

// ── Adapter types ────────────────────────────────────────────

// toolExecutorAdapter adapts tools.Registry to agent.ToolExecutor.
// It looks up the sandbox for the session from the workspace manager
// and passes it through to the tool via ToolContext.
type toolExecutorAdapter struct {
	registry     *tools.Registry
	workspaceMgr *workspace.Manager
}

func (a *toolExecutorAdapter) ExecuteTool(ctx context.Context, name string, args json.RawMessage, sessionID string) (json.RawMessage, error) {
	var sandbox tools.SandboxRunner
	if a.workspaceMgr != nil {
		sb, err := a.workspaceMgr.Get(sessionID)
		if err == nil && sb != nil {
			sandbox = sb
		}
	}

	return a.registry.Execute(ctx, name, args, tools.ToolContext{
		SessionID:  sessionID,
		Sandbox:    sandbox,
		EventStore: nil, // can be wired through if tools need it
	})
}
