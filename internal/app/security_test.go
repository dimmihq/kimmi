package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dimmihq/kimmi/internal/config"
)

func start(t *testing.T, cfg config.Config) (*App, *httptest.Server) {
	t.Helper()
	a, err := New(context.Background(), cfg, "test", "abc", quietLog())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { a.Close() })
	srv := httptest.NewServer(a.Handler())
	t.Cleanup(srv.Close)
	return a, srv
}

func sqliteURL(t *testing.T) string { return "sqlite://" + filepath.Join(t.TempDir(), "kimmi.db") }

const bootstrapFile = `{"projects": [{"name": "Production", "slug": "production", "platform": "react",
  "origin": "https://example.com", "origins": ["https://example.com"], "publicKey": "km_pub_0123456789abcdef"}]}`

func TestClosedSignupsAfterBootstrap(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bootstrap.json")
	os.WriteFile(path, []byte(bootstrapFile), 0o600)
	_, srv := start(t, testConfigWith(t, sqliteURL(t), "KIMMI_SIGNUPS", "closed", "KIMMI_BOOTSTRAP", path))
	c := newClient(t, srv.URL)
	var status obj
	c.do("GET", "/api/v1/auth/status", nil, 200, &status)
	if status["hasUsers"] != true || status["signups"] != "closed" {
		t.Fatalf("status %v: a bootstrapped instance must show the login page", status)
	}
	c.do("POST", "/api/v1/auth/signup", obj{"name": "Eve", "email": "eve@evil.dev", "password": "correct horse"}, 403, nil)

	// The bootstrapped key records at once.
	res, err := http.Get(srv.URL + "/i/v1/config?key=km_pub_0123456789abcdef")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 403 { // the request has no Origin and the project lists one
		t.Fatalf("config for the bootstrapped key: %d", res.StatusCode)
	}
}

func TestClosedSignupsFirstUser(t *testing.T) {
	_, srv := start(t, testConfigWith(t, sqliteURL(t), "KIMMI_SIGNUPS", "closed"))
	c := newClient(t, srv.URL)
	c.do("POST", "/api/v1/auth/signup", obj{"name": "Ada", "email": "ada@acme.dev", "password": "correct horse"}, 201, nil)
	newClient(t, srv.URL).do("POST", "/api/v1/auth/signup", obj{"name": "Eve", "email": "eve@acme.dev", "password": "correct horse"}, 403, nil)
}

func TestOwnerFromEnvironment(t *testing.T) {
	db := sqliteURL(t)
	_, srv := start(t, testConfigWith(t, db, "KIMMI_OWNER", "ops@example.com:a long password", "KIMMI_ORG", "dimmi",
		"KIMMI_SIGNUPS", "closed"))
	c := newClient(t, srv.URL)
	var me struct {
		User struct{ Role string }
		Org  struct{ Name string }
	}
	c.do("POST", "/api/v1/auth/login", obj{"email": "ops@example.com", "password": "a long password"}, 200, &me)
	if me.User.Role != "owner" || me.Org.Name != "dimmi" {
		t.Fatalf("login %+v", me)
	}
	srv.Close()
	// A restart with another value changes nothing: a user exists.
	_, srv2 := start(t, testConfigWith(t, db, "KIMMI_OWNER", "ops@example.com:another password"))
	newClient(t, srv2.URL).do("POST", "/api/v1/auth/login", obj{"email": "ops@example.com", "password": "another password"}, 401, nil)
	newClient(t, srv2.URL).do("POST", "/api/v1/auth/login", obj{"email": "ops@example.com", "password": "a long password"}, 200, nil)
}

func TestBootstrapKeyConflictStopsStart(t *testing.T) {
	db := sqliteURL(t)
	path := filepath.Join(t.TempDir(), "bootstrap.json")
	os.WriteFile(path, []byte(bootstrapFile), 0o600)
	a, err := New(context.Background(), testConfigWith(t, db, "KIMMI_BOOTSTRAP", path), "t", "c", quietLog())
	if err != nil {
		t.Fatal(err)
	}
	a.Close()
	// The same file again is a no-op.
	a, err = New(context.Background(), testConfigWith(t, db, "KIMMI_BOOTSTRAP", path), "t", "c", quietLog())
	if err != nil {
		t.Fatalf("restart with the same file: %v", err)
	}
	a.Close()
	os.WriteFile(path, []byte(strings.Replace(bootstrapFile, "0123456789abcdef", "ffffffffffffffff", 1)), 0o600)
	if _, err := New(context.Background(), testConfigWith(t, db, "KIMMI_BOOTSTRAP", path), "t", "c", quietLog()); err == nil ||
		!strings.Contains(err.Error(), "production") {
		t.Fatalf("a changed key did not stop the start: %v", err)
	}
}

func TestAuthRateLimit(t *testing.T) {
	_, srv := start(t, testConfigWith(t, sqliteURL(t), "KIMMI_AUTH_RATE", "10", "KIMMI_AUTH_BURST", "3"))
	c := newClient(t, srv.URL)
	for range 3 {
		c.do("POST", "/api/v1/auth/login", obj{"email": "nobody@acme.dev", "password": "wrong password"}, 401, nil)
	}
	req, _ := http.NewRequest("POST", srv.URL+"/api/v1/auth/login", strings.NewReader(`{"email":"a@b.c","password":"x"}`))
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 429 || res.Header.Get("Retry-After") == "" {
		t.Fatalf("fourth attempt: %d %v", res.StatusCode, res.Header)
	}
	// Other routes are not limited.
	c.do("GET", "/api/v1/auth/status", nil, 200, nil)
}

func TestSecurityHeadersAndCookies(t *testing.T) {
	_, srv := start(t, testConfigWith(t, sqliteURL(t), "KIMMI_PUBLIC_URL", "https://replay.example.com"))
	res, err := http.Get(srv.URL + "/recordings")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	h := res.Header
	if h.Get("X-Frame-Options") != "DENY" || h.Get("Content-Security-Policy") == "" ||
		h.Get("Strict-Transport-Security") == "" || h.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("dashboard headers %v", h)
	}
	res, err = http.Get(srv.URL + "/i/v1/config?key=x")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.Header.Get("Content-Security-Policy") != "" || res.Header.Get("X-Frame-Options") != "" {
		t.Fatal("ingest responses carry dashboard headers")
	}
	body := strings.NewReader(`{"name":"Ada","email":"ada@acme.dev","password":"correct horse"}`)
	res, err = http.Post(srv.URL+"/api/v1/auth/signup", "application/json", body)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	cookies := res.Cookies()
	if len(cookies) != 1 || !cookies[0].Secure || !cookies[0].HttpOnly {
		t.Fatalf("cookies %+v", cookies)
	}
}

// Nodes starting together on PostgreSQL create one organisation, one owner
// and each project once.
func TestBootstrapConcurrentPostgres(t *testing.T) {
	db := postgresURL(t)
	path := filepath.Join(t.TempDir(), "bootstrap.json")
	os.WriteFile(path, []byte(bootstrapFile), 0o600)
	cfg := testConfigWith(t, db, "KIMMI_BOOTSTRAP", path, "KIMMI_OWNER", "ops@example.com:a long password")
	errs := make(chan error, 4)
	for range 4 {
		go func() {
			a, err := New(context.Background(), cfg, "t", "c", quietLog())
			if err == nil {
				a.Close()
			}
			errs <- err
		}()
	}
	for range 4 {
		if err := <-errs; err != nil {
			t.Fatal(err)
		}
	}
	a, srv := start(t, cfg)
	projects, err := a.Store.ListAllProjects(context.Background())
	if err != nil || len(projects) != 1 {
		t.Fatalf("%d projects, %v", len(projects), err)
	}
	c := newClient(t, srv.URL)
	c.do("POST", "/api/v1/auth/login", obj{"email": "ops@example.com", "password": "a long password"}, 200, nil)
	var members []obj
	c.do("GET", "/api/v1/members", nil, 200, &members)
	var list []obj
	c.do("GET", "/api/v1/projects", nil, 200, &list)
	if len(members) != 1 || len(list) != 1 {
		t.Fatalf("members %v projects %v: the owner and the project are not in one organisation", members, list)
	}
}

func TestScrubSettings(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bootstrap.json")
	os.WriteFile(path, []byte(strings.Replace(bootstrapFile, `"publicKey"`, `"settings": {"privacy": {"scrubPhones": false}}, "publicKey"`, 1)), 0o600)
	_, srv := start(t, testConfigWith(t, sqliteURL(t), "KIMMI_BOOTSTRAP", path, "KIMMI_OWNER", "ops@example.com:a long password"))
	req, _ := http.NewRequest("GET", srv.URL+"/i/v1/config?key=km_pub_0123456789abcdef", nil)
	req.Header.Set("Origin", "https://example.com")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var cfg struct{ Privacy map[string]any }
	json.NewDecoder(res.Body).Decode(&cfg)
	res.Body.Close()
	if cfg.Privacy["scrubEmails"] != true || cfg.Privacy["scrubPhones"] != false {
		t.Fatalf("config privacy %v", cfg.Privacy)
	}
	c := newClient(t, srv.URL)
	c.do("POST", "/api/v1/auth/login", obj{"email": "ops@example.com", "password": "a long password"}, 200, nil)
	var list []struct{ ID string }
	c.do("GET", "/api/v1/projects", nil, 200, &list)
	var set struct{ Privacy map[string]any }
	c.do("PATCH", "/api/v1/projects/"+list[0].ID+"/settings", obj{"privacy": obj{"scrubEmails": false, "scrubPhones": true}}, 200, &set)
	if set.Privacy["scrubEmails"] != false || set.Privacy["scrubPhones"] != true {
		t.Fatalf("patched %v", set.Privacy)
	}
	c.do("GET", "/api/v1/projects/"+list[0].ID+"/settings", nil, 200, &set)
	if set.Privacy["scrubEmails"] != false || set.Privacy["maskAllInputs"] != true {
		t.Fatalf("read back %v", set.Privacy)
	}
}
