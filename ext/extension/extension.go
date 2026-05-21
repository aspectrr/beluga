// Package extension provides the public API for Beluga extensions.
//
// Extensions must use this package (not internal/core/extension) to implement
// the Extension interface. This package re-exports the types so that external
// extension repositories can compile against Beluga without importing internal packages.
package extension

import (
	"github.com/aspectrr/beluga/internal/core/extension"
)

// Extension is the interface all extensions implement.
type Extension = extension.Extension

// ExtensionContext is everything an extension gets access to during Init.
// Re-exported from internal for external extension use.
type ExtensionContext = extension.ExtensionContext
