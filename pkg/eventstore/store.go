// Package eventstore re-exports the core event store for use by extensions.
package eventstore

import (
	internal "github.com/aspectrr/beluga/internal/core/eventstore"
)

// Store provides append-only event operations.
type Store = internal.Store
