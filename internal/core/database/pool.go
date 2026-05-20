package database

import (
	"context"
	"fmt"
	"strings"

	"github.com/collinpfeifer/beluga/internal/core/config"
	"github.com/jackc/pgx/v5/pgxpool"
)

// NewPool creates a new pgxpool.Pool from the given database config.
func NewPool(ctx context.Context, cfg config.DatabaseConfig) (*pgxpool.Pool, error) {
	poolCfg, err := pgxpool.ParseConfig(cfg.DSN())
	if err != nil {
		return nil, fmt.Errorf("parsing pool config: %w", err)
	}

	if cfg.MaxConnections > 0 {
		poolCfg.MaxConns = int32(cfg.MaxConnections)
	}

	pool, err := pgxpool.NewWithConfig(ctx, poolCfg)
	if err != nil {
		return nil, fmt.Errorf("creating pool: %w", err)
	}

	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("pinging database: %w", err)
	}

	return pool, nil
}

// NewExtPool creates a connection pool using the restricted beluga_ext role.
// The DSN is modified to connect as the extension role and restrict the
// search_path to the extension's schema + public (read-only).
func NewExtPool(ctx context.Context, cfg config.DatabaseConfig, extName string) (*pgxpool.Pool, error) {
	dsn := cfg.DSN()

	// Override user/password for the restricted role.
	dsn = rewriteDSNUser(dsn, "beluga_ext", cfg.ExtRolePassword)

	// Set search_path to extension schema + public.
	schemaName := "ext_" + extName
	dsn = ensureDSNParam(dsn, "search_path", schemaName+",public")

	poolCfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("parsing ext pool config: %w", err)
	}

	// Extensions get a smaller connection limit.
	maxConns := int32(5)
	if cfg.MaxConnections > 0 {
		maxConns = int32(cfg.MaxConnections) / 4
		if maxConns < 2 {
			maxConns = 2
		}
	}
	poolCfg.MaxConns = maxConns

	pool, err := pgxpool.NewWithConfig(ctx, poolCfg)
	if err != nil {
		return nil, fmt.Errorf("creating ext pool: %w", err)
	}

	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("pinging ext database: %w", err)
	}

	return pool, nil
}

// rewriteDSNUser replaces the user and password in a DSN.
func rewriteDSNUser(dsn, user, password string) string {
	parts := strings.SplitN(dsn, "@", 2)
	if len(parts) != 2 {
		return dsn
	}
	// parts[0] = "postgres://olduser:oldpass" or "postgres://olduser"
	schemeUser := "postgres://" + user + ":" + password
	return schemeUser + "@" + parts[1]
}

// ensureDSNParam appends or replaces a query parameter in a DSN.
func ensureDSNParam(dsn, key, value string) string {
	param := key + "=" + value
	if strings.Contains(dsn, key+"=") {
		// Replace existing parameter.
		idx := strings.Index(dsn, key+"=")
		end := strings.IndexByte(dsn[idx:], '&')
		if end == -1 {
			return dsn[:idx] + param
		}
		return dsn[:idx] + param + dsn[idx+end:]
	}
	// Append new parameter.
	if strings.Contains(dsn, "?") {
		return dsn + "&" + param
	}
	return dsn + "?" + param
}
