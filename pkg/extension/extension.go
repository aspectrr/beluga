// Package extension provides the public Extension interface and ExtensionContext
// that all Beluga extensions implement. This is the stable API for extension authors.
package extension

import (
	"context"
	"encoding/json"
	"log/slog"

	"github.com/aspectrr/beluga/internal/core/database"
	"github.com/aspectrr/beluga/internal/core/eventstore"
	"github.com/aspectrr/beluga/internal/core/model"
	"github.com/aspectrr/beluga/internal/core/session"
	"github.com/aspectrr/beluga/internal/core/tools"
)

// Extension is the interface all extensions implement.
type Extension interface {
	// Name returns the extension's identifier (used in config and logging).
	Name() string

	// Init is called once at startup. Parse config, create clients,
	// register tools in the registry. Extensions that need gRPC
	// register services on ctx.GRPC here.
	Init(ctx ExtensionContext) error

	// Start is called after all extensions have been initialized.
	// Use it to start background goroutines (connectors, listeners).
	// Must block until ctx is cancelled or Stop is called.
	Start(ctx context.Context) error

	// Stop is called on graceful shutdown. Clean up resources.
	Stop(ctx context.Context) error
}

// ExtensionContext is everything an extension gets access to.
type ExtensionContext struct {
	// Config is the raw YAML config for this extension from beluga.yaml.
	Config json.RawMessage

	// Core services the extension can use.
	Registry *tools.Registry   // Register tools here
	Sessions *session.Store    // Create/query sessions
	Events   *eventstore.Store // Append/query events
	DB       *database.ExtDB   // Restricted database access — see database.ExtPermissions
	Docker   interface{}       // *client.Client — use interface{} to avoid docker import
	Logger   *slog.Logger

	// PromptDir is the path to .beluga/prompts/. Extensions can write
	// prompt template files here to inject behavioral context.
	PromptDir string

	// GRPC is nil unless ext_host is enabled. Extensions that need gRPC
	// (like remora) should check this and fail clearly.
	GRPC interface{} // **GRPCProvider — nil unless ext_host extension is enabled

	// CreateSession creates a new agent session from an external event.
	// Connectors call this when they detect a new task/mention/message.
	CreateSession func(ctx context.Context, source, sourceID string, initialMessage string, metadata json.RawMessage) (*model.Session, error)
}
