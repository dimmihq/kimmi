package sqlstore

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/dimmihq/kimmi/internal/store"
	"github.com/dimmihq/kimmi/internal/store/storetest"
)

func TestSQLite(t *testing.T) {
	storetest.Run(t, func(t *testing.T) store.Store {
		db, err := Open(context.Background(), "sqlite://"+filepath.Join(t.TempDir(), "kimmi.db"))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { db.Close() })
		return db
	})
}

// openPostgres gives a test its own database on the server at
// KIMMI_TEST_POSTGRES_URL and drops it afterwards.
func openTestPostgres(t *testing.T) *DB {
	base := os.Getenv("KIMMI_TEST_POSTGRES_URL")
	if base == "" {
		t.Skip("KIMMI_TEST_POSTGRES_URL not set")
	}
	admin, err := sql.Open("pgx", base)
	if err != nil {
		t.Fatal(err)
	}
	name := "kimmi_test_" + strings.ReplaceAll(uuid.NewString()[:13], "-", "")
	if _, err := admin.Exec("CREATE DATABASE " + name); err != nil {
		t.Fatal(err)
	}
	u, _ := url.Parse(base)
	u.Path = "/" + name
	db, err := Open(context.Background(), u.String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		db.Close()
		admin.Exec("DROP DATABASE IF EXISTS " + name + " WITH (FORCE)")
		admin.Close()
	})
	return db
}

func TestPostgres(t *testing.T) {
	storetest.Run(t, func(t *testing.T) store.Store { return openTestPostgres(t) })
}

// TestPostgresDropsPartitions checks that a day whose recordings are all
// past retention goes as one DROP TABLE.
func TestPostgresDropsPartitions(t *testing.T) {
	db := openTestPostgres(t)
	ctx := context.Background()
	now := time.Now()
	old := now.AddDate(0, 0, -400)
	if err := db.MaintainPartitions(ctx, old.UnixMilli()); err != nil {
		t.Fatal(err)
	}
	org := store.Org{ID: store.NewID(), Name: "Acme", CreatedAt: 1}
	if err := db.CreateOrgWithOwner(ctx, org, store.User{ID: store.NewID(), OrgID: org.ID, Name: "A", Email: "a@a.a", PasswordHash: "x", Role: "owner"}); err != nil {
		t.Fatal(err)
	}
	p := store.Project{ID: store.NewID(), OrgID: org.ID, Name: "p", Slug: "p", Platform: "react", Timezone: "UTC",
		PublicKey: "km_pub_1234567890abcdef", Settings: []byte("{}"), RetentionDays: 30}
	if err := db.CreateProject(ctx, p); err != nil {
		t.Fatal(err)
	}
	blocks := []store.IngestBlock{}
	for i, ts := range []int64{old.UnixMilli(), old.UnixMilli() + 1000, now.UnixMilli()} {
		blocks = append(blocks, store.IngestBlock{Block: store.Block{SessionID: store.NewID(), ProjectID: p.ID, FileKey: "live/x.bin",
			Length: 10, FirstTs: ts, LastTs: ts + 1}, OrgID: org.ID, AnonymousID: fmt.Sprint("a", i), StartedAt: ts, Path: "/"})
	}
	if err := db.ApplyFlush(ctx, blocks, now.UnixMilli()); err != nil {
		t.Fatal(err)
	}
	if n, _, err := db.ExpireSessions(ctx, now.UnixMilli()); err != nil || n != 2 {
		t.Fatalf("expired %d, %v", n, err)
	}
	n, err := db.PurgeDeleted(ctx, now.UnixMilli())
	if err != nil || n != 2 {
		t.Fatalf("purged %d, %v", n, err)
	}
	var left int
	db.r.row(ctx, "SELECT COUNT(*) FROM pg_class WHERE relname = ?", partitionName(old.UTC())).Scan(&left)
	if left != 0 {
		t.Fatal("the expired day's partition is still there")
	}
	page, _ := db.ListRecordings(ctx, store.RecordingQuery{ProjectID: p.ID})
	if page.Total != 1 {
		t.Fatalf("%d recordings left, want 1", page.Total)
	}
}

func TestMigrateTwice(t *testing.T) {
	path := "sqlite://" + filepath.Join(t.TempDir(), "kimmi.db")
	for range 2 {
		db, err := Open(context.Background(), path)
		if err != nil {
			t.Fatal(err)
		}
		db.Close()
	}
}

func TestBind(t *testing.T) {
	c := conn{pg: true}
	if got := c.bind("a = ? AND b IN (?, ?)"); got != "a = $1 AND b IN ($2, $3)" {
		t.Fatal(got)
	}
	if got := (conn{}).bind("a = ?"); got != "a = ?" {
		t.Fatal(got)
	}
}
