// Package extension provides the public Extension interface and ExtensionContext
// that all Beluga extensions implement. This is the stable API for extension authors.
package extension

import (
	"context"
	"database/sql"
	"encoding/json"
	"log/slog"

	"github.com/collinpfeifer/beluga/internal/core/eventstore"
	"github.com/collinpfeifer/beluga/internal/core/session"
	"github.com/collinpfeifer/beluga/internal/core/tools"
	"github.com/collinpfeifer/beluga/pkg/model"
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

// GRPCProvider provides gRPC server infrastructure for extensions.
// Provided by the ext_host extension. Nil unless ext_host is enabled.
type GRPCProvider = interface {
	RegisterService(desc interface{}, impl interface{})
}

// ExtensionContext is everything an extension gets access to.
type ExtensionContext struct {
	// Raw config from the YAML section matching the extension name.
	Config json.RawMessage

	// Core services the extension can use.
	Registry *tools.Registry   // Register tools here
	Sessions *session.Store    // Create/query sessions
	Events   *eventstore.Store // Append/query events
	DB       *sql.DB           // Direct database access for custom queries/migrations
	Docker   interface{}       // Docker client (nil if not needed)
	Logger   *slog.Logger

	// PromptDir is the path to .beluga/prompts/. Extensions can write
	// prompt template files here to inject behavioral context.
	PromptDir string

	// GRPC — nil unless ext_host is enabled. Check before using.
	GRPC GRPCProvider

	// CreateSession creates a new agent session from an external event.
	// Connectors call this when they detect a new task/mention/message.
	CreateSession func(ctx context.Context, source, sourceID string, metadata json.RawMessage) (*model.Session, error)
}
