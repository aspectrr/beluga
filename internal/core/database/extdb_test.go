package database

import (
	"context"
	"testing"
)

// extDBForTest creates an ExtDB with default permissions for testing.
func extDBForTest(name string) *ExtDB {
	// We test the validation logic without a real database connection.
	// NewExtDB accepts a nil pool since validation happens before any DB call.
	return &ExtDB{
		pool:        nil,
		permissions: DefaultExtPermissions(name),
		extName:     name,
		cache:       make(map[string]string),
	}
}

// ─── Always-blocked statements ────────────────────────────────────

func TestExtDB_BlocksDropTable(t *testing.T) {
	db := extDBForTest("myext")
	err := db.validate("DROP TABLE sessions")
	if err == nil {
		t.Fatal("expected DROP TABLE to be blocked")
	}
	t.Logf("blocked as expected: %v", err)
}

func TestExtDB_BlocksDropTableIfExists(t *testing.T) {
	db := extDBForTest("myext")
	err := db.validate("DROP TABLE IF EXISTS some_table")
	if err == nil {
		t.Fatal("expected DROP TABLE IF EXISTS to be blocked")
	}
}

func TestExtDB_BlocksTruncate(t *testing.T) {
	db := extDBForTest("myext")
	err := db.validate("TRUNCATE sessions CASCADE")
	if err == nil {
		t.Fatal("expected TRUNCATE to be blocked")
	}
}

func TestExtDB_BlocksGrant(t *testing.T) {
	db := extDBForTest("myext")
	err := db.validate("GRANT ALL ON sessions TO public")
	if err == nil {
		t.Fatal("expected GRANT to be blocked")
	}
}

func TestExtDB_BlocksRevoke(t *testing.T) {
	db := extDBForTest("myext")
	err := db.validate("REVOKE ALL ON sessions FROM public")
	if err == nil {
		t.Fatal("expected REVOKE to be blocked")
	}
}

func TestExtDB_BlocksVacuum(t *testing.T) {
	db := extDBForTest("myext")
	err := db.validate("VACUUM sessions")
	if err == nil {
		t.Fatal("expected VACUUM to be blocked")
	}
}

func TestExtDB_BlocksRename(t *testing.T) {
	db := extDBForTest("myext")
	err := db.validate("RENAME TABLE sessions TO bad")
	if err == nil {
		t.Fatal("expected RENAME to be blocked")
	}
}

func TestExtDB_BlocksReindex(t *testing.T) {
	db := extDBForTest("myext")
	err := db.validate("REINDEX TABLE sessions")
	if err == nil {
		t.Fatal("expected REINDEX to be blocked")
	}
}

// ─── Core table write protection ──────────────────────────────────

func TestExtDB_BlocksInsertIntoCoreTable(t *testing.T) {
	db := extDBForTest("myext")
	err := db.validate("INSERT INTO sessions (source, source_id) VALUES ($1, $2)")
	if err == nil {
		t.Fatal("expected INSERT into sessions to be blocked")
	}
}

func TestExtDB_BlocksUpdateCoreTable(t *testing.T) {
	db := extDBForTest("myext")
	err := db.validate("UPDATE sessions SET status = $1 WHERE id = $2")
	if err == nil {
		t.Fatal("expected UPDATE on sessions to be blocked")
	}
}

func TestExtDB_BlocksDeleteFromCoreTable(t *testing.T) {
	db := extDBForTest("myext")
	err := db.validate("DELETE FROM events WHERE session_id = $1")
	if err == nil {
		t.Fatal("expected DELETE from events to be blocked")
	}
}

func TestExtDB_BlocksInsertIntoEvents(t *testing.T) {
	db := extDBForTest("myext")
	err := db.validate("INSERT INTO events (session_id, seq, type, data) VALUES ($1, $2, $3, $4)")
	if err == nil {
		t.Fatal("expected INSERT into events to be blocked")
	}
}

// ─── Allowed operations ───────────────────────────────────────────

func TestExtDB_AllowsSelectFromSessions(t *testing.T) {
	db := extDBForTest("myext")
	err := db.validate("SELECT id, source, source_id FROM sessions WHERE id = $1")
	if err != nil {
		t.Fatalf("expected SELECT on sessions to be allowed, got: %v", err)
	}
}

func TestExtDB_AllowsSelectFromEvents(t *testing.T) {
	db := extDBForTest("myext")
	err := db.validate("SELECT id, session_id, seq, type FROM events WHERE session_id = $1 ORDER BY seq ASC LIMIT $2")
	if err != nil {
		t.Fatalf("expected SELECT on events to be allowed, got: %v", err)
	}
}

func TestExtDB_AllowsCreateTableInExtensionSchema(t *testing.T) {
	db := extDBForTest("myext")
	err := db.validate("CREATE TABLE ext_myext.custom_data (id UUID PRIMARY KEY, data JSONB)")
	if err != nil {
		t.Fatalf("expected CREATE TABLE in ext schema to be allowed, got: %v", err)
	}
}

func TestExtDB_AllowsInsertIntoExtensionTable(t *testing.T) {
	db := extDBForTest("myext")
	err := db.validate("INSERT INTO ext_myext.custom_data (id, data) VALUES ($1, $2)")
	if err != nil {
		t.Fatalf("expected INSERT into extension table to be allowed, got: %v", err)
	}
}

func TestExtDB_AllowsCreateTableInPublic(t *testing.T) {
	db := extDBForTest("myext")
	err := db.validate("CREATE TABLE public.myext_state (key TEXT PRIMARY KEY, value JSONB)")
	if err != nil {
		t.Fatalf("expected CREATE TABLE in public to be allowed, got: %v", err)
	}
}

// ─── Read-only mode ───────────────────────────────────────────────

func TestExtDB_ReadOnlyBlocksInsert(t *testing.T) {
	db := extDBForTest("myext")
	db.permissions.ReadOnly = true
	err := db.validate("INSERT INTO ext_myext.custom_data (id) VALUES ($1)")
	if err == nil {
		t.Fatal("expected INSERT to be blocked in read-only mode")
	}
}

func TestExtDB_ReadOnlyBlocksCreate(t *testing.T) {
	db := extDBForTest("myext")
	db.permissions.ReadOnly = true
	err := db.validate("CREATE TABLE ext_myext.custom_data (id UUID PRIMARY KEY)")
	if err == nil {
		t.Fatal("expected CREATE to be blocked in read-only mode")
	}
}

func TestExtDB_ReadOnlyAllowsSelect(t *testing.T) {
	db := extDBForTest("myext")
	db.permissions.ReadOnly = true
	err := db.validate("SELECT * FROM sessions")
	if err != nil {
		t.Fatalf("expected SELECT to be allowed in read-only mode, got: %v", err)
	}
}

// ─── CanModifyCoreTables override ─────────────────────────────────

func TestExtDB_CanModifyCoreTablesAllowsWrite(t *testing.T) {
	db := extDBForTest("myext")
	db.permissions.CanModifyCoreTables = true
	err := db.validate("INSERT INTO sessions (source, source_id) VALUES ($1, $2)")
	if err != nil {
		t.Fatalf("expected INSERT to be allowed with CanModifyCoreTables, got: %v", err)
	}
}

// ─── CanCreateTables false ────────────────────────────────────────

func TestExtDB_CannotCreateTables(t *testing.T) {
	db := extDBForTest("myext")
	db.permissions.CanCreateTables = false
	err := db.validate("CREATE TABLE ext_myext.data (id INT)")
	if err == nil {
		t.Fatal("expected CREATE to be blocked when CanCreateTables is false")
	}
}

// ─── Schema restriction ───────────────────────────────────────────

func TestExtDB_BlocksCreateInDisallowedSchema(t *testing.T) {
	db := extDBForTest("myext")
	// Remove "public" from allowed schemas to test this path.
	db.permissions.AllowedSchemas = []string{"ext_myext"}
	err := db.validate("CREATE TABLE some_other_schema.data (id INT)")
	if err == nil {
		t.Fatal("expected CREATE in disallowed schema to be blocked")
	}
}

// ─── Case insensitivity ───────────────────────────────────────────

func TestExtDB_BlocksDropCaseInsensitive(t *testing.T) {
	db := extDBForTest("myext")
	err := db.validate("drop table sessions")
	if err == nil {
		t.Fatal("expected lowercase 'drop table' to be blocked")
	}
}

func TestExtDB_BlocksTruncateWithLeadingSpaces(t *testing.T) {
	db := extDBForTest("myext")
	err := db.validate("  TRUNCATE  sessions")
	if err == nil {
		t.Fatal("expected TRUNCATE with leading spaces to be blocked")
	}
}

// ─── Edge cases ───────────────────────────────────────────────────

func TestExtDB_BlocksEmptyStatement(t *testing.T) {
	db := extDBForTest("myext")
	err := db.validate("")
	if err == nil {
		t.Fatal("expected empty statement to be blocked")
	}
}

func TestExtDB_BlocksWhitespaceOnly(t *testing.T) {
	db := extDBForTest("myext")
	err := db.validate("   ")
	if err == nil {
		t.Fatal("expected whitespace-only statement to be blocked")
	}
}

func TestExtDB_AllowsComplexJoin(t *testing.T) {
	db := extDBForTest("myext")
	err := db.validate(`
		SELECT s.id, s.source, e.type, e.data
		FROM sessions s
		JOIN events e ON e.session_id = s.id
		WHERE s.status = 'running'
		ORDER BY e.seq ASC
		LIMIT 100
	`)
	if err != nil {
		t.Fatalf("expected complex JOIN to be allowed, got: %v", err)
	}
}

func TestExtDB_AllowsWithCTESelect(t *testing.T) {
	db := extDBForTest("myext")
	err := db.validate(`
		WITH recent AS (
			SELECT session_id, MAX(seq) as max_seq
			FROM events
			GROUP BY session_id
		)
		SELECT * FROM recent
	`)
	if err != nil {
		t.Fatalf("expected CTE SELECT to be allowed, got: %v", err)
	}
}

// ─── ExtTx validates too ──────────────────────────────────────────

func TestExtTx_BlocksDangerousStatement(t *testing.T) {
	db := extDBForTest("myext")
	tx := &ExtTx{tx: nil, db: db}

	err := tx.db.validate("DROP TABLE sessions")
	if err == nil {
		t.Fatal("expected ExtTx to block DROP TABLE")
	}
}

// ─── errRow ───────────────────────────────────────────────────────

func TestErrRow_ScanReturnsError(t *testing.T) {
	ctx := context.Background()
	db := extDBForTest("myext")

	// QueryRow with blocked SQL should return an errRow.
	row := db.QueryRow(ctx, "DROP TABLE sessions")
	err := row.Scan()
	if err == nil {
		t.Fatal("expected errRow.Scan() to return validation error")
	}
}

// ─── EnsureSchema ─────────────────────────────────────────────────

func TestExtDB_EnsureSchema_NoPool(t *testing.T) {
	db := extDBForTest("myext")
	// Without a pool, EnsureSchema should error on Ping/Exec.
	err := db.EnsureSchema(context.Background())
	if err == nil {
		t.Fatal("expected error without pool connection")
	}
	t.Logf("expected pool error: %v", err)
}
