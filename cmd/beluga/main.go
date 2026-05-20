// beluga is the main Beluga daemon and CLI.
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

	"github.com/collinpfeifer/beluga/internal/cli/extend"
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
	if len(os.Args) < 2 {
		printUsage()
		os.Exit(1)
	}

	switch os.Args[1] {
	case "start":
		fs := flag.NewFlagSet("start", flag.ExitOnError)
		configPath := fs.String("config", "configs/beluga.yaml", "path to config file")
		belugaDir := fs.String("beluga-dir", ".beluga", "path to .beluga directory")
		fs.Parse(os.Args[2:])
		runStart(*configPath, *belugaDir)

	case "onboard":
		fs := flag.NewFlagSet("onboard", flag.ExitOnError)
		configPath := fs.String("config", "configs/beluga.yaml", "path to config file")
		fs.Parse(os.Args[2:])
		runOnboard(*configPath)

	case "status":
		fs := flag.NewFlagSet("status", flag.ExitOnError)
		configPath := fs.String("config", "configs/beluga.yaml", "path to config file")
		fs.Parse(os.Args[2:])
		runStatus(*configPath)

	case "extend":
		if len(os.Args) < 3 {
			fmt.Fprintln(os.Stderr, "Usage: beluga extend <create|verify|install> [args]")
			fmt.Fprintln(os.Stderr)
			fmt.Fprintln(os.Stderr, "Subcommands:")
			fmt.Fprintln(os.Stderr, "  create <name> [--type local|remote]  Scaffold a new extension")
			fmt.Fprintln(os.Stderr, "  verify <path>                        Compile, test, validate tool schemas")
			fmt.Fprintln(os.Stderr, "  install <path-or-url>                 Install extension (rebuild + restart)")
			os.Exit(1)
		}
		switch os.Args[2] {
		case "create":
			fs := flag.NewFlagSet("extend create", flag.ExitOnError)
			extType := fs.String("type", "local", "extension type: local or remote")
			fs.Parse(os.Args[3:])
			if fs.NArg() < 1 {
				fmt.Fprintln(os.Stderr, "Usage: beluga extend create <name> [--type local|remote]")
				os.Exit(1)
			}
			runExtendCreate(fs.Arg(0), *extType)

		case "verify":
			fs := flag.NewFlagSet("extend verify", flag.ExitOnError)
			fs.Parse(os.Args[3:])
			if fs.NArg() < 1 {
				fmt.Fprintln(os.Stderr, "Usage: beluga extend verify <path>")
				os.Exit(1)
			}
			runExtendVerify(fs.Arg(0))

		case "install":
			fs := flag.NewFlagSet("extend install", flag.ExitOnError)
			fs.Parse(os.Args[3:])
			if fs.NArg() < 1 {
				fmt.Fprintln(os.Stderr, "Usage: beluga extend install <path>")
				os.Exit(1)
			}
			runExtendInstall(fs.Arg(0))

		default:
			fmt.Fprintf(os.Stderr, "Unknown extend subcommand: %s\n", os.Args[2])
			fmt.Fprintln(os.Stderr, "Available: create, verify, install")
			os.Exit(1)
		}

	case "help", "--help", "-h":
		printUsage()

	default:
		fmt.Fprintf(os.Stderr, "Unknown command: %s\n", os.Args[1])
		fmt.Fprintln(os.Stderr)
		printUsage()
		os.Exit(1)
	}
}

func printUsage() {
	fmt.Fprintln(os.Stderr, "Beluga — Managed Agents that grow with you.")
	fmt.Fprintln(os.Stderr)
	fmt.Fprintln(os.Stderr, "Usage:")
	fmt.Fprintln(os.Stderr, "  beluga <command> [options]")
	fmt.Fprintln(os.Stderr)
	fmt.Fprintln(os.Stderr, "Commands:")
	fmt.Fprintln(os.Stderr, "  onboard                    Onboard Beluga (LLM setup, connector setup)")
	fmt.Fprintln(os.Stderr, "  start                      Start the daemon")
	fmt.Fprintln(os.Stderr, "  status                     Show running sessions, extensions, connected hosts")
	fmt.Fprintln(os.Stderr, "  extend create <name>       Scaffold a new extension")
	fmt.Fprintln(os.Stderr, "  extend verify <path>       Compile, test, validate tool schemas")
	fmt.Fprintln(os.Stderr, "  extend install <path>      Install extension (rebuild + restart)")
	fmt.Fprintln(os.Stderr)
	fmt.Fprintln(os.Stderr, "Run 'beluga <command> --help' for more information on a command.")
}

// ─── start ────────────────────────────────────────────────────────

// runStart starts the Beluga daemon. This is the full startup sequence
// from Phase 1: database, stores, tools, workspace, extensions, agent loop.
func runStart(configPath, belugaDir string) {
	// Setup structured JSON logger.
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))
	slog.SetDefault(logger)

	logger.Info("beluga starting")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// ── Load config ───────────────────────────────────────────
	cfg, err := config.LoadConfig(configPath)
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
	promptDir := filepath.Join(belugaDir, "prompts")
	skillsDir := filepath.Join(belugaDir, "skills")
	systemPromptPath := filepath.Join(belugaDir, "SYSTEM.md")

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

	logger.Info("tools registered", "count", len(registryDefs))

	// ── Extension manager ─────────────────────────────────────
	extMgr := extension.NewManager(logger)

	// Build the shared extension context template.
	extCtx := extension.ExtensionContext{
		Registry:      registry,
		Sessions:      sessions,
		Events:        events,
		DB:            nil, // set per-extension below
		Docker:        nil, // workspace manager available via adapter if needed
		Logger:        logger,
		PromptDir:     promptDir,
		CreateSession: orchestratorInst.HandleNewSession,
	}

	// Register enabled extensions with their configs.
	// Each extension gets its own restricted ExtDB handle.
	for _, name := range cfg.EnabledExtensions() {
		rawCfg := cfg.ExtensionRawConfig(name)
		extCtxCopy := extCtx
		extCtxCopy.Config = rawCfg

		// Create a restricted database handle for this extension.
		extDB := database.NewExtDB(pool, name, database.DefaultExtPermissions(name))
		if err := extDB.EnsureSchema(ctx); err != nil {
			logger.Warn("could not create extension schema", "name", name, "error", err)
		}
		extCtxCopy.DB = extDB

		// Look up the extension in the registry.
		if ext := lookupExtension(name); ext != nil {
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

// ─── onboard ──────────────────────────────────────────────────────

func runOnboard(configPath string) {
	fmt.Fprintln(os.Stderr, "onboard: not yet implemented")
	fmt.Fprintln(os.Stderr)
	fmt.Fprintln(os.Stderr, "Onboarding will guide you through:")
	fmt.Fprintln(os.Stderr, "  1. LLM endpoint + API key setup")
	fmt.Fprintln(os.Stderr, "  2. Embedding model detection (optional)")
	fmt.Fprintln(os.Stderr, "  3. Chat connector selection")
	fmt.Fprintln(os.Stderr)
	fmt.Fprintf(os.Stderr, "Config will be written to %s\n", configPath)
	os.Exit(1)
}

// ─── status ───────────────────────────────────────────────────────

func runStatus(configPath string) {
	fmt.Fprintln(os.Stderr, "status: not yet implemented")
	fmt.Fprintln(os.Stderr)
	fmt.Fprintln(os.Stderr, "Status will show:")
	fmt.Fprintln(os.Stderr, "  - Running sessions")
	fmt.Fprintln(os.Stderr, "  - Active extensions")
	fmt.Fprintln(os.Stderr, "  - Connected hosts")
	fmt.Fprintln(os.Stderr, "  - Workspace sandboxes")
	os.Exit(1)
}

// ─── extend create ────────────────────────────────────────────────

func runExtendCreate(name, extType string) {
	cfg := extend.ScaffoldConfig{
		Name:   name,
		Type:   extType,
		OutDir: ".",
	}
	if err := extend.Scaffold(cfg); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}
	fmt.Fprintf(os.Stderr, "Extension '%s' scaffolded in ./%s/\n", name, name)
	fmt.Fprintf(os.Stderr, "Next steps:\n")
	fmt.Fprintf(os.Stderr, "  1. Edit the tools and logic in ./%s/\n", name)
	fmt.Fprintf(os.Stderr, "  2. Verify: beluga extend verify ./%s\n", name)
	fmt.Fprintf(os.Stderr, "  3. Install: beluga extend install ./%s\n", name)
}

// ─── extend verify ────────────────────────────────────────────────

func runExtendVerify(path string) {
	result, err := extend.Verify(path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}

	if err := extend.PrintVerifyResult(result); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}

	// Exit with non-zero if verification failed.
	if !result.Compiles || !result.TestsPass {
		os.Exit(1)
	}
}

// ─── extend install ───────────────────────────────────────────────

func runExtendInstall(source string) {
	cfg := extend.InstallConfig{
		Source: source,
	}
	if err := extend.Install(cfg); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}
}

// ─── Shared helpers ───────────────────────────────────────────────

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

// lookupExtension returns an extension by name from the compiled-in registry.
// Extensions are registered here when installed via `beluga extend install`.
// When no extensions are installed, this always returns nil.
func lookupExtension(name string) extension.Extension {
	// Extensions are discovered at build time. When `beluga extend install`
	// copies an extension into internal/extensions/{name}/, it also generates
	// an import and case here. With no extensions installed, this returns nil.
	//
	// Example (after `beluga extend install clickup`):
	//   import "github.com/collinpfeifer/beluga/internal/extensions/clickup"
	//   case "clickup": return &clickup.Extension{}
	_ = name
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

// ── Adapter types ─────────────────────────────────────────────────

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
