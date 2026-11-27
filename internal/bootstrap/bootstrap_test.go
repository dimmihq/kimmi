package bootstrap

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dimmihq/kimmi/internal/auth"
	"github.com/dimmihq/kimmi/internal/settings"
	"github.com/dimmihq/kimmi/internal/store"
	"github.com/dimmihq/kimmi/internal/store/sqlstore"
)

func openDB(t *testing.T) *sqlstore.DB {
	db, err := sqlstore.Open(context.Background(), "sqlite://"+filepath.Join(t.TempDir(), "k.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func writeFile(t *testing.T, body string) string {
	p := filepath.Join(t.TempDir(), "bootstrap.json")
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestOwner(t *testing.T) {
	ctx := context.Background()
	db := openDB(t)
	created, err := Owner(ctx, db, "dimmi", "ops@example.com", "a long password")
	if err != nil || !created {
		t.Fatalf("first start: %v %v", created, err)
	}
	u, err := db.GetUserByEmail(ctx, "ops@example.com")
	if err != nil || u.Role != store.RoleOwner || !auth.CheckPassword(u.PasswordHash, "a long password") {
		t.Fatalf("owner %+v %v", u, err)
	}
	org, _ := db.GetOrg(ctx, u.OrgID)
	if org.Name != "dimmi" {
		t.Fatalf("org %+v", org)
	}
	// Once a user exists the variable is ignored, even with another value.
	created, err = Owner(ctx, db, "dimmi", "other@example.com", "another password")
	if err != nil || created {
		t.Fatalf("second start: %v %v", created, err)
	}
	if _, err := db.GetUserByEmail(ctx, "other@example.com"); err == nil {
		t.Fatal("a second owner was created")
	}
}

func TestOwnerJoinsBootstrappedOrg(t *testing.T) {
	ctx := context.Background()
	db := openDB(t)
	org, err := Org(ctx, db, "acme")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Owner(ctx, db, "ignored", "ops@example.com", "a long password"); err != nil {
		t.Fatal(err)
	}
	u, _ := db.GetUserByEmail(ctx, "ops@example.com")
	if u.OrgID != org.ID {
		t.Fatal("the owner went to a second organisation")
	}
}

const file = `{"projects": [
  {"name": "Production", "slug": "production", "platform": "react", "origin": "https://example.com",
   "origins": ["https://example.com", "https://*.example.com"], "publicKey": "km_pub_0123456789abcdef",
   "settings": {"privacy": {"maskAllText": true}, "retention": {"days": 90}}},
  {"name": "Docs", "slug": "docs", "platform": "astro", "origin": "https://docs.example.com", "publicKey": "km_pub_fedcba9876543210"}
]}`

func find(t *testing.T, db *sqlstore.DB, slug string) store.Project {
	projects, err := db.ListAllProjects(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range projects {
		if p.Slug == slug {
			return p
		}
	}
	t.Fatalf("no project %s", slug)
	return store.Project{}
}

func TestApply(t *testing.T) {
	ctx := context.Background()
	db := openDB(t)
	f, err := Load(writeFile(t, file))
	if err != nil {
		t.Fatal(err)
	}
	res, err := Apply(ctx, db, "kimmi", f)
	if err != nil || len(res.Created) != 2 {
		t.Fatalf("first apply: %+v %v", res, err)
	}
	projects, _ := db.ListAllProjects(ctx)
	if len(projects) != 2 {
		t.Fatalf("%d projects", len(projects))
	}
	p := find(t, db, "production")
	s := settings.Decode(p.Settings, p.RetentionDays, p.KeepStarred)
	if p.PublicKey != "km_pub_0123456789abcdef" || p.Slug != "production" || len(p.Origins) != 2 ||
		!s.Privacy.MaskAllText || !s.Privacy.MaskAllInputs || p.RetentionDays != 90 {
		t.Fatalf("project %+v settings %+v", p, s)
	}

	// A dashboard edit survives a restart with the same file.
	p.Name, p.RetentionDays = "Renamed", 7
	if err := db.UpdateProject(ctx, p); err != nil {
		t.Fatal(err)
	}
	res, err = Apply(ctx, db, "kimmi", f)
	if err != nil || len(res.Created) != 0 || len(res.Kept) != 2 {
		t.Fatalf("restart: %+v %v", res, err)
	}
	again, _ := db.ListAllProjects(ctx)
	if got := find(t, db, "production"); len(again) != 2 || got.Name != "Renamed" || got.RetentionDays != 7 {
		t.Fatalf("restart changed projects: %+v", got)
	}
	if org, err := db.FirstOrg(ctx); err != nil || org.Name != "kimmi" || org.ID != p.OrgID {
		t.Fatalf("organisation %+v %v", org, err)
	}

	// The same slug with another key stops the server.
	conflict, err := Load(writeFile(t, strings.Replace(file, "km_pub_0123456789abcdef", "km_pub_aaaaaaaaaaaaaaaa", 1)))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Apply(ctx, db, "kimmi", conflict); err == nil || !strings.Contains(err.Error(), "never changes a key") {
		t.Fatalf("key conflict: %v", err)
	}
	if find(t, db, "production").PublicKey != "km_pub_0123456789abcdef" {
		t.Fatal("the key was changed")
	}
}

func TestLoadRejects(t *testing.T) {
	for name, body := range map[string]string{
		"bad key":       strings.Replace(file, "km_pub_0123456789abcdef", "km_pub_0123456789ABCDEF", 1),
		"short key":     strings.Replace(file, "km_pub_0123456789abcdef", "km_pub_0123", 1),
		"no slug":       strings.Replace(file, `"slug": "docs",`, "", 1),
		"no key":        strings.Replace(file, `, "publicKey": "km_pub_fedcba9876543210"`, "", 1),
		"bad platform":  strings.Replace(file, `"astro"`, `"cobol"`, 1),
		"bad settings":  strings.Replace(file, `"days": 90`, `"days": 3`, 1),
		"unknown field": strings.Replace(file, `"name": "Docs"`, `"name": "Docs", "colour": "red"`, 1),
		"duplicate key": strings.Replace(file, "km_pub_fedcba9876543210", "km_pub_0123456789abcdef", 1),
		"not json":      `{"projects": [`,
	} {
		if _, err := Load(writeFile(t, body)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}
