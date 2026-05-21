// Package session re-exports the core session store for use by extensions.
package session

import (
	internal "github.com/aspectrr/beluga/internal/core/session"
)

// Store provides session CRUD operations.
type Store = internal.Store
