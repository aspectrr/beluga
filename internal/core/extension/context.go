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

// ExtensionContext is everything an extension gets access to during Init.
type ExtensionContext struct {
	// Config is the raw YAML config for this extension from beluga.yaml.
	Config json.RawMessage

	// Core services the extension can use.
	Registry *tools.Registry   // Register tools here
	Sessions *session.Store    // Create/query sessions
	Events   *eventstore.Store // Append/query events
	DB       *database.ExtDB   // Restricted database access — see database.ExtPermissions
	Docker   interface{}       // *client.Client — use interface{} to avoid docker import; cast if needed
	Logger   *slog.Logger

	// PromptDir is the path to .beluga/prompts/. Extensions can write
	// prompt template files here to inject behavioral context into the system prompt.
	PromptDir string

	// GRPC is nil unless ext_host is enabled. Extensions that need gRPC
	// (like remora) should check this and fail clearly.
	GRPC interface{} // *GRPCProvider — nil unless ext_host extension is enabled

	// CreateSession creates a new agent session from an external event.
	// Connectors call this when they detect a new task/mention/message.
	// The initialMessage is seeded as the first user_message event.
	CreateSession func(ctx context.Context, source, sourceID string, initialMessage string, metadata json.RawMessage) (*model.Session, error)
}
