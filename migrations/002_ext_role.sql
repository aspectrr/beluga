-- +goose Up
-- Create a restricted database role for extension access.
-- Extensions connect through this role via the ExtDB wrapper,
-- providing defense-in-depth beyond the Go-level SQL validation.

-- The beluga_ext role can only read core tables and has full
-- control over extension-scoped schemas (ext_*).
CREATE ROLE beluga_ext WITH LOGIN PASSWORD 'beluga_ext Restricted extensions only - change in production';

-- Grant read-only access to core tables.
GRANT SELECT ON sessions TO beluga_ext;
GRANT SELECT ON events TO beluga_ext;
GRANT SELECT ON schema_migrations TO beluga_ext;

-- Extensions should NOT be able to:
--   INSERT/UPDATE/DELETE on core tables
--   DROP/ALTER/TRUNCATE any table
--   GRANT/REVOKE permissions

-- Allow extensions to use the ext_ prefix for their own schemas.
-- Individual extension schemas are created by EnsureSchema() and
-- granted explicitly during extension initialization.

-- +goose Down
DROP ROLE IF EXISTS beluga_ext;
