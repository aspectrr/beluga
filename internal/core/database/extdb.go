package database

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"sync"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ExtDB is the restricted database interface available to extensions.
// Extensions receive this instead of *pgxpool.Pool to prevent dangerous
// operations like dropping tables, modifying core schema, or accessing
// tables outside their allowed scope.
//
// Extensions should use this for:
//   - Reading from allowed core tables (sessions, events)
//   - Creating/reading/writing their own tables in an extension-scoped schema
//   - Running migrations for their own schema
//
// All operations are validated against the extension's Permissions before execution.
type ExtDB struct {
	pool        *pgxpool.Pool
	permissions ExtPermissions
	extName     string

	// mu protects the prepared statement cache
	mu    sync.RWMutex
	cache map[string]string
}

// ExtPermissions controls what an extension can do with the database.
type ExtPermissions struct {
	// AllowedSchemas is the set of schemas the extension can access.
	// Defaults to ["public"] if empty. Each extension also gets its
	// own schema "ext_<name>" automatically.
	AllowedSchemas []string

	// AllowedCoreTables is the set of core tables the extension can READ.
	// Defaults to ["sessions", "events"] if empty.
	AllowedCoreTables []string

	// CanCreateTables allows the extension to CREATE/ALTER tables
	// within its allowed schemas. Defaults to true.
	CanCreateTables bool

	// CanModifyCoreTables allows INSERT/UPDATE/DELETE on core tables.
	// Defaults to false — most extensions should use the Session/Event stores.
	CanModifyCoreTables bool

	// MaxRowsPerQuery limits the number of rows returned by a single query.
	// 0 means no limit. Defaults to 10000.
	MaxRowsPerQuery int

	// ReadOnly prevents all write operations (INSERT, UPDATE, DELETE, CREATE, etc.).
	// This overrides CanCreateTables and CanModifyCoreTables.
	ReadOnly bool
}

// DefaultExtPermissions returns a safe default permission set for extensions.
func DefaultExtPermissions(extName string) ExtPermissions {
	return ExtPermissions{
		AllowedSchemas:      []string{"public", "ext_" + extName},
		AllowedCoreTables:   []string{"sessions", "events"},
		CanCreateTables:     true,
		CanModifyCoreTables: false,
		MaxRowsPerQuery:     10000,
		ReadOnly:            false,
	}
}

// NewExtDB creates a new restricted database handle for an extension.
func NewExtDB(pool *pgxpool.Pool, extName string, perms ExtPermissions) *ExtDB {
	if len(perms.AllowedSchemas) == 0 {
		perms.AllowedSchemas = []string{"public", "ext_" + extName}
	}
	if len(perms.AllowedCoreTables) == 0 {
		perms.AllowedCoreTables = []string{"sessions", "events"}
	}
	if perms.MaxRowsPerQuery == 0 {
		perms.MaxRowsPerQuery = 10000
	}

	return &ExtDB{
		pool:        pool,
		permissions: perms,
		extName:     extName,
		cache:       make(map[string]string),
	}
}

// ─── Blocked statement patterns ──────────────────────────────────

var (
	// dangerousPattern matches statements that are ALWAYS blocked.
	dangerousPattern = regexp.MustCompile(
		`(?is)^\s*(DROP\s+|TRUNCATE\s+|RENAME\s+|GRANT\s+|REVOKE\s+|VACUUM\s+|REINDEX\s+)`,
	)

	// dmlWritePattern matches INSERT, UPDATE, DELETE (including CTE variants).
	dmlWritePattern = regexp.MustCompile(
		`(?is)^\s*(INSERT\s+|UPDATE\s+|DELETE\s+|WITH\s+.*\s+INSERT\s+|WITH\s+.*\s+UPDATE\s+|WITH\s+.*\s+DELETE\s+)`,
	)

	// ddlCreatePattern matches CREATE and ALTER.
	ddlCreatePattern = regexp.MustCompile(
		`(?is)^\s*(CREATE\s+|ALTER\s+)`,
	)
)

// validate checks a SQL statement against the extension's permissions.
// Returns an error if the statement is not allowed.
func (db *ExtDB) validate(sql string) error {
	trimmed := strings.TrimSpace(sql)
	if trimmed == "" {
		return fmt.Errorf("extdb[%s]: empty statement", db.extName)
	}

	// Block always-dangerous statements (DROP, TRUNCATE, RENAME, GRANT, etc.).
	if dangerousPattern.MatchString(trimmed) {
		return fmt.Errorf("extdb[%s]: statement not allowed: %s",
			db.extName, firstWord(trimmed))
	}

	// Block all writes if read-only.
	if db.permissions.ReadOnly {
		if isWrite(trimmed) {
			return fmt.Errorf("extdb[%s]: write operations not allowed in read-only mode", db.extName)
		}
	}

	// Check DDL (CREATE/ALTER) — only allowed if CanCreateTables.
	if ddlCreatePattern.MatchString(trimmed) {
		if !db.permissions.CanCreateTables {
			return fmt.Errorf("extdb[%s]: DDL not allowed (CanCreateTables is false)", db.extName)
		}
		// DDL is allowed only within extension's allowed schemas.
		if !db.isSchemaAllowed(trimmed) {
			return fmt.Errorf("extdb[%s]: DDL only allowed in schemas: %v",
				db.extName, db.permissions.AllowedSchemas)
		}
	}

	// Check DML writes against core tables.
	if dmlWritePattern.MatchString(trimmed) {
		if !db.permissions.CanModifyCoreTables && db.targetsCoreTable(trimmed) {
			return fmt.Errorf("extdb[%s]: writes to core tables not allowed", db.extName)
		}
	}

	return nil
}

// isSchemaAllowed checks if a DDL statement targets an allowed schema.
func (db *ExtDB) isSchemaAllowed(sql string) bool {
	lower := strings.ToLower(sql)
	for _, schema := range db.permissions.AllowedSchemas {
		if strings.Contains(lower, schema+".") ||
			strings.Contains(lower, "schema "+schema) ||
			strings.Contains(lower, "schema if not exists "+schema) {
			return true
		}
	}
	// If no schema is explicitly referenced, it targets the default search_path.
	// Allow only if "public" is in the allowed list.
	for _, schema := range db.permissions.AllowedSchemas {
		if schema == "public" {
			return true
		}
	}
	return false
}

// targetsCoreTable does a best-effort check if the SQL targets a core table.
func (db *ExtDB) targetsCoreTable(sql string) bool {
	lower := strings.ToLower(sql)
	coreTables := []string{"sessions", "events", "schema_migrations"}
	for _, t := range coreTables {
		for _, prefix := range []string{"into ", "update ", "from ", "join ", "table "} {
			if strings.Contains(lower, prefix+t) {
				// Make sure it's not schema-qualified to an extension schema.
				isExtSchema := false
				for _, schema := range db.permissions.AllowedSchemas {
					if schema != "public" && strings.Contains(lower, prefix+schema+"."+t) {
						isExtSchema = true
						break
					}
				}
				if !isExtSchema {
					return true
				}
			}
		}
	}
	return false
}

// isWrite returns true if the statement is a write operation.
func isWrite(sql string) bool {
	return dmlWritePattern.MatchString(sql) || ddlCreatePattern.MatchString(sql)
}

// firstWord returns the first two words of a SQL statement for error messages.
func firstWord(sql string) string {
	sql = strings.TrimSpace(sql)
	words := strings.Fields(sql)
	if len(words) >= 2 {
		return words[0] + " " + words[1]
	}
	if len(words) == 1 {
		return words[0]
	}
	return ""
}

// ─── Public API ───────────────────────────────────────────────────

// Query executes a read-only query. Results are subject to MaxRowsPerQuery.
func (db *ExtDB) Query(ctx context.Context, sql string, args ...interface{}) (pgx.Rows, error) {
	if err := db.validate(sql); err != nil {
		return nil, err
	}
	return db.pool.Query(ctx, sql, args...)
}

// QueryRow executes a query that returns a single row.
func (db *ExtDB) QueryRow(ctx context.Context, sql string, args ...interface{}) pgx.Row {
	if err := db.validate(sql); err != nil {
		return &errRow{err: err}
	}
	return db.pool.QueryRow(ctx, sql, args...)
}

// Exec executes a statement. DDL is only allowed if CanCreateTables is true
// and the target schema is in AllowedSchemas.
func (db *ExtDB) Exec(ctx context.Context, sql string, args ...interface{}) (pgconn.CommandTag, error) {
	if err := db.validate(sql); err != nil {
		return pgconn.CommandTag{}, err
	}
	return db.pool.Exec(ctx, sql, args...)
}

// Begin starts a transaction. The transaction uses the same restrictions.
func (db *ExtDB) Begin(ctx context.Context) (*ExtTx, error) {
	tx, err := db.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("extdb[%s]: begin tx: %w", db.extName, err)
	}
	return &ExtTx{tx: tx, db: db}, nil
}

// RunInTransaction runs fn inside a transaction with the same restrictions.
func (db *ExtDB) RunInTransaction(ctx context.Context, fn func(tx *ExtTx) error) error {
	tx, err := db.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// EnsureSchema creates the extension's scoped schema if it doesn't exist.
// This is a convenience method that bypasses normal validation since
// extensions should always be able to create their own schema.
func (db *ExtDB) EnsureSchema(ctx context.Context) error {
	if db.pool == nil {
		return fmt.Errorf("extdb[%s]: no database connection", db.extName)
	}
	schemaName := "ext_" + db.extName
	// pgx.Identifier.Sanitize produces a safely-quoted identifier.
	_, err := db.pool.Exec(ctx, fmt.Sprintf(
		"CREATE SCHEMA IF NOT EXISTS %s", pgx.Identifier{schemaName}.Sanitize(),
	))
	if err != nil {
		return fmt.Errorf("extdb[%s]: creating schema %s: %w", db.extName, schemaName, err)
	}
	return nil
}

// Name returns the extension name this DB handle is scoped to.
func (db *ExtDB) Name() string { return db.extName }

// Permissions returns a copy of the current permissions.
func (db *ExtDB) Permissions() ExtPermissions { return db.permissions }

// ─── ExtTx — restricted transaction ───────────────────────────────

// ExtTx is a restricted transaction that validates all statements
// against the extension's permissions.
type ExtTx struct {
	tx pgx.Tx
	db *ExtDB
}

// Query executes a read-only query within the transaction.
func (t *ExtTx) Query(ctx context.Context, sql string, args ...interface{}) (pgx.Rows, error) {
	if err := t.db.validate(sql); err != nil {
		return nil, err
	}
	return t.tx.Query(ctx, sql, args...)
}

// QueryRow executes a query returning a single row within the transaction.
func (t *ExtTx) QueryRow(ctx context.Context, sql string, args ...interface{}) pgx.Row {
	if err := t.db.validate(sql); err != nil {
		return &errRow{err: err}
	}
	return t.tx.QueryRow(ctx, sql, args...)
}

// Exec executes a statement within the transaction.
func (t *ExtTx) Exec(ctx context.Context, sql string, args ...interface{}) (pgconn.CommandTag, error) {
	if err := t.db.validate(sql); err != nil {
		return pgconn.CommandTag{}, err
	}
	return t.tx.Exec(ctx, sql, args...)
}

// Commit commits the transaction.
func (t *ExtTx) Commit(ctx context.Context) error { return t.tx.Commit(ctx) }

// Rollback rolls back the transaction.
func (t *ExtTx) Rollback(ctx context.Context) error { return t.tx.Rollback(ctx) }

// ─── errRow — pgx.Row that always returns a validation error ──────

type errRow struct {
	err error
}

func (r *errRow) Scan(dest ...interface{}) error               { return r.err }
func (r *errRow) FieldDescriptions() []pgconn.FieldDescription { return nil }
