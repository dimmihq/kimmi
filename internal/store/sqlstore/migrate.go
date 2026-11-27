package sqlstore

import (
	"context"
	"embed"
	"fmt"
	"io/fs"
	"slices"
	"strconv"
	"strings"
	"time"
)

//go:embed migrations
var migrations embed.FS

// migrate applies every migration file of the dialect that has not run yet,
// each in its own transaction. PostgreSQL serialises concurrent starters
// with an advisory lock.
func (d *DB) migrate(ctx context.Context) error {
	// CREATE TABLE IF NOT EXISTS is not safe against a concurrent creator
	// on PostgreSQL, so nodes starting together take turns from the start.
	return d.Exclusive(ctx, func() error { return d.migrateLocked(ctx) })
}

func (d *DB) migrateLocked(ctx context.Context) error {
	if _, err := d.w.exec(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at BIGINT NOT NULL)`); err != nil {
		return fmt.Errorf("create schema_migrations: %w", err)
	}
	dir := "migrations/" + d.driver
	entries, err := fs.ReadDir(migrations, dir)
	if err != nil {
		return fmt.Errorf("read migrations: %w", err)
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	slices.Sort(names)
	for _, name := range names {
		version, err := strconv.Atoi(strings.SplitN(name, "_", 2)[0])
		if err != nil {
			return fmt.Errorf("migration %s: name must start with a number", name)
		}
		body, err := migrations.ReadFile(dir + "/" + name)
		if err != nil {
			return fmt.Errorf("read migration %s: %w", name, err)
		}
		err = d.tx(ctx, func(c conn) error {
			if d.pg() {
				if _, err := c.exec(ctx, "SELECT pg_advisory_xact_lock(7151)"); err != nil {
					return err
				}
			}
			var n int
			if err := c.row(ctx, "SELECT COUNT(*) FROM schema_migrations WHERE version = ?", version).Scan(&n); err != nil {
				return err
			}
			if n > 0 {
				return nil
			}
			for _, stmt := range strings.Split(string(body), ";\n") {
				if strings.TrimSpace(stmt) == "" {
					continue
				}
				if _, err := c.exec(ctx, stmt); err != nil {
					return fmt.Errorf("%w\n%s", err, stmt)
				}
			}
			_, err := c.exec(ctx, "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", version, time.Now().UnixMilli())
			return err
		})
		if err != nil {
			return fmt.Errorf("migration %s: %w", name, err)
		}
	}
	return d.MaintainPartitions(ctx, time.Now().UnixMilli())
}
