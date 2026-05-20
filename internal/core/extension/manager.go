package extension

import (
	"context"
	"fmt"
	"log/slog"
)

// Extension is the interface all extensions implement.
type Extension interface {
	// Name returns the extension's identifier (used in config and logging).
	Name() string

	// Init is called once at startup. Use it to parse config, create clients,
	// register tools, run database migrations, and write prompt templates.
	// Extensions that need gRPC (like remora) check ctx.GRPC here.
	Init(ctx ExtensionContext) error

	// Start is called after all extensions have been initialized.
	// Use it to start background goroutines (connectors, listeners).
	// Must block until ctx is cancelled or Stop is called.
	Start(ctx context.Context) error

	// Stop is called on graceful shutdown. Clean up resources.
	Stop(ctx context.Context) error
}

// Manager manages extension lifecycle: registration, init, start, and stop.
type Manager struct {
	logger     *slog.Logger
	extensions []Extension
	contexts   []ExtensionContext
}

// NewManager creates a new extension manager.
func NewManager(logger *slog.Logger) *Manager {
	return &Manager{
		logger: logger,
	}
}

// Register adds an extension with its context. Extensions are registered
// in config order — order matters for dependencies (e.g. ext_host before remora).
func (m *Manager) Register(ext Extension, ctx ExtensionContext) {
	m.extensions = append(m.extensions, ext)
	m.contexts = append(m.contexts, ctx)
	m.logger.Info("extension registered", "name", ext.Name())
}

// InitAll calls Init on each registered extension in order.
// Returns on the first error.
func (m *Manager) InitAll() error {
	for i, ext := range m.extensions {
		m.logger.Info("initializing extension", "name", ext.Name())
		if err := ext.Init(m.contexts[i]); err != nil {
			return fmt.Errorf("extension %q init failed: %w", ext.Name(), err)
		}
		m.logger.Info("extension initialized", "name", ext.Name())
	}
	return nil
}

// StartAll calls Start on each registered extension.
// Each Start call runs in its own goroutine so extensions can block.
func (m *Manager) StartAll(ctx context.Context) error {
	for _, ext := range m.extensions {
		ext := ext
		m.logger.Info("starting extension", "name", ext.Name())
		go func() {
			if err := ext.Start(ctx); err != nil && ctx.Err() == nil {
				m.logger.Error("extension start failed", "name", ext.Name(), "error", err)
			}
		}()
	}
	return nil
}

// StopAll calls Stop on each registered extension. It continues even if one fails,
// ensuring all extensions get a chance to clean up.
func (m *Manager) StopAll(ctx context.Context) error {
	var firstErr error
	// Stop in reverse order (last registered stops first).
	for i := len(m.extensions) - 1; i >= 0; i-- {
		ext := m.extensions[i]
		m.logger.Info("stopping extension", "name", ext.Name())
		if err := ext.Stop(ctx); err != nil {
			m.logger.Error("extension stop failed", "name", ext.Name(), "error", err)
			if firstErr == nil {
				firstErr = fmt.Errorf("extension %q stop failed: %w", ext.Name(), err)
			}
		}
	}
	return firstErr
}
