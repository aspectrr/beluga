// Package model re-exports the core model types for use by extensions.
// Extensions should import this package instead of internal/core/model.
package model

import (
	internal "github.com/collinpfeifer/beluga/internal/core/model"
)

// Session represents a durable agent session.
type Session = internal.Session

// Event represents a single entry in the append-only event log.
type Event = internal.Event

// Status constants.
const (
	StatusPending   = internal.StatusPending
	StatusRunning   = internal.StatusRunning
	StatusSuspended = internal.StatusSuspended
	StatusCompleted = internal.StatusCompleted
	StatusFailed    = internal.StatusFailed
)

// Event type constants.
const (
	EventTypeUserMessage      = internal.EventTypeUserMessage
	EventTypeAgentMessage     = internal.EventTypeAgentMessage
	EventTypeToolCall         = internal.EventTypeToolCall
	EventTypeToolResult       = internal.EventTypeToolResult
	EventTypeInterrupt        = internal.EventTypeInterrupt
	EventTypeStatusTransition = internal.EventTypeStatusTransition
	EventTypeError            = internal.EventTypeError
	EventTypeCompacted        = internal.EventTypeCompacted
)
