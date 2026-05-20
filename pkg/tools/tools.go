// Package tools re-exports the core tool types for use by extensions.
// Extensions should import this package instead of internal/core/tools.
package tools

import (
	internal "github.com/collinpfeifer/beluga/internal/core/tools"
)

// Tool is the interface that all agent tools must implement.
type Tool = internal.Tool

// ToolDef describes a tool for the LLM's function calling schema.
type ToolDef = internal.ToolDef

// ToolContext provides context for a tool execution.
type ToolContext = internal.ToolContext

// SandboxRunner is the interface for workspace sandbox operations.
type SandboxRunner = internal.SandboxRunner

// Registry manages tool registration and dispatch.
type Registry = internal.Registry
