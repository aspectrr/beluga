package tools

import (
	"context"
	"encoding/json"
	"fmt"
)

// --- workspace_bash ---

// WorkspaceBashTool executes a bash command in the agent workspace sandbox.
type WorkspaceBashTool struct{}

func (t *WorkspaceBashTool) Definition() ToolDef {
	return ToolDef{
		Name:        "workspace_bash",
		Description: "Execute a bash command in the agent workspace sandbox.",
		Parameters:  json.RawMessage(`{"type":"object","properties":{"command":{"type":"string","description":"The bash command to execute"}},"required":["command"]}`),
	}
}

func (t *WorkspaceBashTool) Execute(ctx context.Context, args json.RawMessage, tctx ToolContext) (json.RawMessage, error) {
	if tctx.Sandbox == nil {
		return nil, fmt.Errorf("no sandbox available")
	}

	var params struct {
		Command string `json:"command"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return nil, fmt.Errorf("parsing args: %w", err)
	}

	stdout, stderr, exitCode, err := tctx.Sandbox.Exec(ctx, "bash", "-c", params.Command)
	if err != nil {
		return nil, fmt.Errorf("executing command: %w", err)
	}

	return json.Marshal(map[string]interface{}{
		"stdout":    stdout,
		"stderr":    stderr,
		"exit_code": exitCode,
	})
}

// --- workspace_read_file ---

// WorkspaceReadFileTool reads a file from the agent workspace sandbox.
type WorkspaceReadFileTool struct{}

func (t *WorkspaceReadFileTool) Definition() ToolDef {
	return ToolDef{
		Name:        "workspace_read_file",
		Description: "Read a file from the agent workspace sandbox.",
		Parameters:  json.RawMessage(`{"type":"object","properties":{"path":{"type":"string","description":"Absolute path to the file in the sandbox"}},"required":["path"]}`),
	}
}

func (t *WorkspaceReadFileTool) Execute(ctx context.Context, args json.RawMessage, tctx ToolContext) (json.RawMessage, error) {
	if tctx.Sandbox == nil {
		return nil, fmt.Errorf("no sandbox available")
	}

	var params struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return nil, fmt.Errorf("parsing args: %w", err)
	}

	content, err := tctx.Sandbox.ReadFile(ctx, params.Path)
	if err != nil {
		return nil, fmt.Errorf("reading file: %w", err)
	}

	return json.Marshal(map[string]string{"content": content})
}

// --- workspace_edit_file ---

// WorkspaceWriteFileTool writes content to a file in the agent workspace sandbox.
type WorkspaceWriteFileTool struct{}

func (t *WorkspaceWriteFileTool) Definition() ToolDef {
	return ToolDef{
		Name:        "workspace_edit_file",
		Description: "Write content to a file in the agent workspace sandbox.",
		Parameters:  json.RawMessage(`{"type":"object","properties":{"path":{"type":"string","description":"Absolute path to the file in the sandbox"},"content":{"type":"string","description":"The content to write"}},"required":["path","content"]}`),
	}
}

func (t *WorkspaceWriteFileTool) Execute(ctx context.Context, args json.RawMessage, tctx ToolContext) (json.RawMessage, error) {
	if tctx.Sandbox == nil {
		return nil, fmt.Errorf("no sandbox available")
	}

	var params struct {
		Path    string `json:"path"`
		Content string `json:"content"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return nil, fmt.Errorf("parsing args: %w", err)
	}

	if err := tctx.Sandbox.WriteFile(ctx, params.Path, []byte(params.Content)); err != nil {
		return nil, fmt.Errorf("writing file: %w", err)
	}

	return json.Marshal(map[string]string{"status": "ok"})
}

// RegisterWorkspaceTools registers all built-in workspace tools.
func RegisterWorkspaceTools(registry *Registry) error {
	workspaceTools := []Tool{
		&WorkspaceBashTool{},
		&WorkspaceReadFileTool{},
		&WorkspaceWriteFileTool{},
	}
	for _, t := range workspaceTools {
		if err := registry.Register(t); err != nil {
			return err
		}
	}
	return nil
}
