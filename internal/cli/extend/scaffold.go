package extend

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// ScaffoldConfig holds options for scaffolding a new extension.
type ScaffoldConfig struct {
	Name   string // extension name (e.g. "jira")
	Type   string // "local" or "remote"
	OutDir string // output directory (default: current dir)
}

// Scaffold creates the extension directory and boilerplate files.
func Scaffold(cfg ScaffoldConfig) error {
	if cfg.Name == "" {
		return fmt.Errorf("extension name is required")
	}
	if cfg.Type == "" {
		cfg.Type = "local"
	}
	if cfg.OutDir == "" {
		cfg.OutDir = "."
	}

	// Sanitize package name: lowercase, replace dashes with underscores.
	pkgName := strings.ToLower(cfg.Name)
	pkgName = strings.ReplaceAll(pkgName, "-", "_")

	dir := filepath.Join(cfg.OutDir, cfg.Name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("creating extension directory: %w", err)
	}

	switch cfg.Type {
	case "local":
		return scaffoldLocal(dir, cfg.Name, pkgName)
	case "remote":
		return scaffoldRemote(dir, cfg.Name, pkgName)
	default:
		return fmt.Errorf("unknown extension type %q: must be local or remote", cfg.Type)
	}
}

func scaffoldLocal(dir, name, pkgName string) error {
	files := map[string]string{
		"extension.go":      localExtensionGo(name, pkgName),
		"tools.go":          localToolsGo(name, pkgName),
		"extension_test.go": localTestGo(name, pkgName),
		"config.yaml":       localConfigYAML(name),
		"README.md":         localReadme(name),
	}

	for filename, content := range files {
		path := filepath.Join(dir, filename)
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			return fmt.Errorf("writing %s: %w", filename, err)
		}
	}

	return nil
}

func scaffoldRemote(dir, name, pkgName string) error {
	files := map[string]string{
		"main.go":    remoteMainGo(name, pkgName),
		"tools.json": remoteToolsJSON(name),
		"README.md":  localReadme(name),
	}

	for filename, content := range files {
		path := filepath.Join(dir, filename)
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			return fmt.Errorf("writing %s: %w", filename, err)
		}
	}

	return nil
}

// ─── Local extension templates ───────────────────────────────────

func localExtensionGo(name, pkgName string) string {
	return fmt.Sprintf(`// Package %s is a Beluga extension.
package %s

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"

	"github.com/collinpfeifer/beluga/internal/core/extension"
	"github.com/collinpfeifer/beluga/internal/core/tools"
)

// Extension implements extension.Extension for %s.
type Extension struct {
	registry *tools.Registry
	logger   *slog.Logger
}

// Name returns the extension identifier.
func (e *Extension) Name() string { return "%s" }

// Init is called once at startup. Parse config, create clients, register tools.
func (e *Extension) Init(ctx extension.ExtensionContext) error {
	// Parse config
	var cfg struct {
		// Add your config fields here, e.g.:
		// Host     string +json:"host"
		// APIToken string +json:"api_token"
	}
	if err := json.Unmarshal(ctx.Config, &cfg); err != nil {
		return fmt.Errorf("parsing config: %%w", err)
	}

	e.registry = ctx.Registry
	e.logger = ctx.Logger

	// Register tools
	e.registry.Register(&ExampleTool{})

	return nil
}

// Start is called after all extensions have been initialized.
// Block until context is cancelled if you have background work.
func (e *Extension) Start(ctx context.Context) error {
	<-ctx.Done()
	return nil
}

// Stop is called on graceful shutdown.
func (e *Extension) Stop(ctx context.Context) error {
	return nil
}
`, pkgName, pkgName, name, name)
}

func localToolsGo(name, pkgName string) string {
	toolName := strings.ReplaceAll(name, "-", "_")
	bt := "`" // backtick, can't use inside raw string literal
	return "package " + pkgName + `

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/collinpfeifer/beluga/internal/core/tools"
)

// ExampleTool is a placeholder tool. Replace with real tools.
type ExampleTool struct{}

// Definition returns the tool schema for LLM function calling.
func (t *ExampleTool) Definition() tools.ToolDef {
	return tools.ToolDef{
		Name:        "` + toolName + `_example",
		Description: "An example tool for the ` + name + ` extension. Replace this with real tools.",
		Parameters: json.RawMessage(` + bt + `{
			"type": "object",
			"properties": {
				"input": {
					"type": "string",
					"description": "Example input parameter"
				}
			},
			"required": ["input"]
		}` + bt + `),
	}
}

// Execute runs the tool.
func (t *ExampleTool) Execute(ctx context.Context, args json.RawMessage, tctx tools.ToolContext) (json.RawMessage, error) {
	var input struct {
		Input string ` + bt + `json:"input"` + bt + `
	}
	if err := json.Unmarshal(args, &input); err != nil {
		return nil, fmt.Errorf("parsing args: %w", err)
	}

	// Replace with real logic.
	result := map[string]string{
		"status": "ok",
		"echo":   input.Input,
	}
	return json.Marshal(result)
}
`
}

func localTestGo(name, pkgName string) string {
	bt := "`" // backtick
	return fmt.Sprintf(`package %s

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/collinpfeifer/beluga/internal/core/tools"
)

func TestExtension(t *testing.T) {
	ext := &Extension{}
	if ext.Name() != "%s" {
		t.Errorf("expected name %%q, got %%q", "%s", ext.Name())
	}
}

func TestToolSchema(t *testing.T) {
	tool := &ExampleTool{}
	def := tool.Definition()

	if def.Name == "" {
		t.Error("tool name is empty")
	}
	if def.Description == "" {
		t.Error("tool description is empty")
	}

	// Validate the parameters are valid JSON.
	var params map[string]interface{}
	if err := json.Unmarshal(def.Parameters, &params); err != nil {
		t.Fatalf("tool parameters are not valid JSON: %%v", err)
	}

	// Check required fields exist in properties.
	schemaType, _ := params["type"].(string)
	if schemaType != "object" {
		t.Errorf("expected schema type 'object', got %%q", schemaType)
	}

	props, _ := params["properties"].(map[string]interface{})
	if len(props) == 0 {
		t.Error("tool schema has no properties")
	}
}

func TestDryRun(t *testing.T) {
	tool := &ExampleTool{}

	// Build minimal valid args from the schema.
	args := json.RawMessage(`+bt+`{"input": "test"}`+bt+`)

	result, err := tool.Execute(context.Background(), args, tools.ToolContext{})
	if err != nil {
		t.Fatalf("dry-run execute failed: %%v", err)
	}

	var output map[string]interface{}
	if err := json.Unmarshal(result, &output); err != nil {
		t.Fatalf("dry-run result is not valid JSON: %%v", err)
	}
}
`, pkgName, name, name)
}

func localConfigYAML(name string) string {
	return fmt.Sprintf(`# Extension config for %s.
# Add this to the extensions section of beluga.yaml:
#
# extensions:
#   %s:
#     enabled: true
#     # Add your config fields here
`, name, name)
}

func localReadme(name string) string {
	toolName := strings.ReplaceAll(name, "-", "_")
	return fmt.Sprintf("# %s extension\n\n> Replace this README with a description of what the %s extension does.\n\n## Tools\n\n- `%s_example` - replace with real tool descriptions\n\n## Config\n\nSee config.yaml for required configuration.\n", name, name, toolName)
}

// ─── Remote extension templates ──────────────────────────────────

func remoteMainGo(name, pkgName string) string {
	return fmt.Sprintf(`// Package main is a remote extension for Beluga.
// It connects to Beluga's ext_host gRPC server and registers tools.
package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Fprintf(os.Stderr, "remote extension %%q: not yet connected to ext_host\\n", "%s")
	fmt.Fprintln(os.Stderr, "Implement gRPC connection to Beluga's ExtensionHost service.")
	os.Exit(1)
}
`, name)
}

func remoteToolsJSON(name string) string {
	toolName := strings.ReplaceAll(name, "-", "_")
	return fmt.Sprintf(`[
  {
    "name": "%s_example",
    "description": "An example tool for the %s remote extension.",
    "parameters": {
      "type": "object",
      "properties": {
        "input": {
          "type": "string",
          "description": "Example input parameter"
        }
      },
      "required": ["input"]
    }
  }
]
`, toolName, name)
}
