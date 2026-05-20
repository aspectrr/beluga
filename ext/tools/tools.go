// Package tools provides the public API for Beluga tool definitions.
//
// Extensions use this package to define tools and register them.
// Re-exported from internal for external extension use.
package tools

import (
	"github.com/collinpfeifer/beluga/internal/core/tools"
)

// Tool is the interface that all agent tools must implement.
type Tool = tools.Tool

// ToolDef describes a tool for the LLM's function calling schema.
type ToolDef = tools.ToolDef

// ToolContext provides context for a tool execution.
type ToolContext = tools.ToolContext

// Registry manages tool registration and dispatch.
type Registry = tools.Registry

// NewRegistry creates a new tool registry.
var NewRegistry = tools.NewRegistry
