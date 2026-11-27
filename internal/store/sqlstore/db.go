// Package sqlstore implements store.Store on SQLite and PostgreSQL with
// hand-written SQL. Queries are written once with ? placeholders; the few
// places where the dialects differ go through the dialect helpers below.
package sqlstore

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	_ "github.com/jackc/pgx/v5/stdlib" // registers the "pgx" database/sql driver
	"modernc.org/sqlite"
	sqlite3 "modernc.org/sqlite/lib"

	"github.com/dimmihq/kimmi/internal/config"
	"github.com/dimmihq/kimmi/internal/store"
)

// DB is a store.Store. SQLite gets a single writer connection next to a pool
// of readers; PostgreSQL uses one pool for both.
type DB struct {
	driver string
	w, r   conn
	close  func() error
}

var _ store.Store = (*DB)(nil)

// Open connects to a KIMMI_DATABASE_URL and runs pending migrations.
func Open(ctx context.Context, databaseURL string) (*DB, error) {
	driver, addr, err := config.SplitDatabaseURL(databaseURL)
	if err != nil {
		return nil, err
	}
	var db *DB
	if driver == "sqlite" {
		db, err = openSQLite(addr)
	} else {
		db, err = openPostgres(addr)
	}
	if err != nil {
		return nil, err
	}
	if err := db.migrate(ctx); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

func openSQLite(path string) (*DB, error) {
	if dir := filepath.Dir(path); dir != "" {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, fmt.Errorf("create database folder: %w", err)
		}
	}
	pragmas := "_pragma=journal_mode(WAL)&_pragma=busy_timeout(10000)&_pragma=foreign_keys(1)&_pragma=synchronous(NORMAL)"
	w, err := sql.Open("sqlite", "file:"+path+"?"+pragmas+"&_txlock=immediate")
	if err != nil {
		return nil, fmt.Errorf("open sqlite %s: %w", path, err)
	}
	w.SetMaxOpenConns(1)
	r, err := sql.Open("sqlite", "file:"+path+"?"+pragmas)
	if err != nil {
		w.Close()
		return nil, fmt.Errorf("open sqlite %s: %w", path, err)
	}
	// Each connection keeps its own page cache (2 MB by default): a few
	// readers are plenty for a dashboard, and idle ones close.
	r.SetMaxOpenConns(4)
	r.SetMaxIdleConns(2)
	r.SetConnMaxIdleTime(time.Minute)
	if err := w.Ping(); err != nil {
		w.Close()
		r.Close()
		return nil, fmt.Errorf("open sqlite %s: %w", path, err)
	}
	return &DB{
		driver: "sqlite",
		w:      conn{q: w},
		r:      conn{q: r},
		close:  func() error { return errors.Join(r.Close(), w.Close()) },
	}, nil
}

func openPostgres(url string) (*DB, error) {
	p, err := sql.Open("pgx", url)
	if err != nil {
		return nil, fmt.Errorf("open postgres: %w", err)
	}
	// The flusher needs one connection and the dashboard a few; idle
	// connections close so a quiet node holds little.
	p.SetMaxOpenConns(10)
	p.SetMaxIdleConns(3)
	p.SetConnMaxIdleTime(2 * time.Minute)
	if err := p.Ping(); err != nil {
		p.Close()
		return nil, fmt.Errorf("connect to postgres: %w", err)
	}
	c := conn{q: p, pg: true}
	return &DB{driver: "postgres", w: c, r: c, close: p.Close}, nil
}

func (d *DB) Driver() string { return d.driver }
func (d *DB) Close() error   { return d.close() }

func (d *DB) Ping(ctx context.Context) error {
	return d.r.q.(*sql.DB).PingContext(ctx)
}

func (d *DB) Version(ctx context.Context) (string, error) {
	q := "SELECT sqlite_version()"
	if d.pg() {
		q = "SHOW server_version"
	}
	var v string
	if err := d.r.row(ctx, q).Scan(&v); err != nil {
		return "", fmt.Errorf("database version: %w", err)
	}
	return v, nil
}

func (d *DB) pg() bool { return d.driver == "postgres" }

// greatest and least name the scalar max/min functions of the dialect.
func (d *DB) greatest() string {
	if d.pg() {
		return "GREATEST"
	}
	return "MAX"
}

func (d *DB) least() string {
	if d.pg() {
		return "LEAST"
	}
	return "MIN"
}

// eachURL is a FROM item that expands sessions.urls (alias s) into rows of u.value.
func (d *DB) eachURL() string {
	if d.pg() {
		return "json_array_elements_text(s.urls::json) AS u(value)"
	}
	return "json_each(s.urls) AS u"
}

type querier interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// conn runs ?-placeholder SQL on a pool or a transaction.
type conn struct {
	q  querier
	pg bool
}

func (c conn) bind(q string) string {
	if !c.pg || !strings.Contains(q, "?") {
		return q
	}
	var b strings.Builder
	b.Grow(len(q) + 16)
	n := 0
	for i := 0; i < len(q); i++ {
		if q[i] == '?' {
			n++
			b.WriteByte('$')
			b.WriteString(strconv.Itoa(n))
			continue
		}
		b.WriteByte(q[i])
	}
	return b.String()
}

// bulkArgs is the placeholder count above which a PostgreSQL statement is
// not kept prepared. Multi-row inserts and long IN lists change shape with
// every batch; caching each shape would fill every connection's statement
// cache (and the server's) with thousands of one-off statements.
const bulkArgs = 16

func (c conn) args(args []any) []any {
	if !c.pg || len(args) <= bulkArgs {
		return args
	}
	return append([]any{pgx.QueryExecModeDescribeExec}, args...)
}

func (c conn) exec(ctx context.Context, q string, args ...any) (sql.Result, error) {
	return c.q.ExecContext(ctx, c.bind(q), c.args(args)...)
}

func (c conn) query(ctx context.Context, q string, args ...any) (*sql.Rows, error) {
	return c.q.QueryContext(ctx, c.bind(q), c.args(args)...)
}

func (c conn) row(ctx context.Context, q string, args ...any) *sql.Row {
	return c.q.QueryRowContext(ctx, c.bind(q), c.args(args)...)
}

// tx runs fn in a write transaction.
func (d *DB) tx(ctx context.Context, fn func(c conn) error) error {
	t, err := d.w.q.(*sql.DB).BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	if err := fn(conn{q: t, pg: d.pg()}); err != nil {
		t.Rollback()
		return err
	}
	if err := t.Commit(); err != nil {
		return fmt.Errorf("commit: %w", err)
	}
	return nil
}

// Exclusive runs fn while holding an instance-wide lock: a PostgreSQL
// advisory lock, so several nodes starting at once take turns. SQLite has a
// single node, which needs no lock.
func (d *DB) Exclusive(ctx context.Context, fn func() error) error {
	if !d.pg() {
		return fn()
	}
	c, err := d.w.q.(*sql.DB).Conn(ctx)
	if err != nil {
		return fmt.Errorf("lock: %w", err)
	}
	defer c.Close()
	if _, err := c.ExecContext(ctx, "SELECT pg_advisory_lock(7152)"); err != nil {
		return fmt.Errorf("lock: %w", err)
	}
	defer c.ExecContext(context.WithoutCancel(ctx), "SELECT pg_advisory_unlock(7152)")
	return fn()
}

// isUnique reports whether err is a unique-constraint violation.
func isUnique(err error) bool {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code == "23505"
	}
	var se *sqlite.Error
	if errors.As(err, &se) {
		return se.Code() == sqlite3.SQLITE_CONSTRAINT_UNIQUE || se.Code() == sqlite3.SQLITE_CONSTRAINT_PRIMARYKEY
	}
	return false
}

// notFound maps sql.ErrNoRows to store.ErrNotFound.
func notFound(err error) error {
	if errors.Is(err, sql.ErrNoRows) {
		return store.ErrNotFound
	}
	return err
}

// mustAffect turns "no rows changed" into store.ErrNotFound.
func mustAffect(res sql.Result, err error) error {
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return store.ErrNotFound
	}
	return nil
}

// placeholders returns "?, ?, ?" for n values.
func placeholders(n int) string {
	if n == 0 {
		return ""
	}
	return strings.Repeat("?, ", n-1) + "?"
}

// inArgs turns strings into query arguments.
func inArgs(ids []string) []any {
	args := make([]any, len(ids))
	for i, id := range ids {
		args[i] = id
	}
	return args
}
