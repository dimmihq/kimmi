package app

import (
	"bytes"
	"compress/gzip"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/dimmihq/kimmi/internal/config"
	"github.com/dimmihq/kimmi/internal/envelope"
	"github.com/dimmihq/kimmi/internal/loadgen"
	"github.com/dimmihq/kimmi/internal/store"
)

func testConfig(t *testing.T) config.Config {
	return testConfigWith(t, "sqlite://"+filepath.Join(t.TempDir(), "kimmi.db"))
}

// postgresURL makes a throwaway database on KIMMI_TEST_POSTGRES_URL.
func postgresURL(t *testing.T) string {
	base := os.Getenv("KIMMI_TEST_POSTGRES_URL")
	if base == "" {
		t.Skip("KIMMI_TEST_POSTGRES_URL not set")
	}
	admin, err := sql.Open("pgx", base)
	if err != nil {
		t.Fatal(err)
	}
	name := "kimmi_e2e_" + strings.ReplaceAll(uuid.NewString()[:13], "-", "")
	if _, err := admin.Exec("CREATE DATABASE " + name); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		admin.Exec("DROP DATABASE IF EXISTS " + name + " WITH (FORCE)")
		admin.Close()
	})
	u, _ := url.Parse(base)
	u.Path = "/" + name
	return u.String()
}

func testConfigWith(t *testing.T, databaseURL string, extra ...string) config.Config {
	t.Helper()
	dir := t.TempDir()
	env := map[string]string{
		"KIMMI_SECRET":         strings.Repeat("s", 40),
		"KIMMI_DATABASE_URL":   databaseURL,
		"KIMMI_STORAGE_PATH":   filepath.Join(dir, "recordings"),
		"KIMMI_FLUSH_INTERVAL": "1h", // the tests flush by hand
		"KIMMI_AUTH_RATE":      "0",
	}
	for i := 0; i+1 < len(extra); i += 2 {
		env[extra[i]] = extra[i+1]
	}
	cfg, err := config.Load(func(k string) string { return env[k] })
	if err != nil {
		t.Fatal(err)
	}
	return cfg
}

func quietLog() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

// client is a dashboard user: a cookie jar and helpers that fail the test
// on an unexpected status.
type client struct {
	t    *testing.T
	base string
	http *http.Client
	auth string
}

func newClient(t *testing.T, base string) *client {
	jar, _ := cookiejar.New(nil)
	return &client{t: t, base: base, http: &http.Client{Jar: jar}}
}

func (c *client) do(method, path string, body any, want int, out any) {
	c.t.Helper()
	var r io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		r = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, c.base+path, r)
	req.Header.Set("Content-Type", "application/json")
	if c.auth != "" {
		req.Header.Set("Authorization", "Bearer "+c.auth)
	}
	res, err := c.http.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(res.Body)
	if res.StatusCode != want {
		c.t.Fatalf("%s %s: status %d, want %d: %s", method, path, res.StatusCode, want, data)
	}
	if out != nil {
		if err := json.Unmarshal(data, out); err != nil {
			c.t.Fatalf("%s %s: %v: %s", method, path, err, data)
		}
	}
}

type obj = map[string]any

// session is a synthetic recording: rrweb-shaped events in batches.
type session struct {
	id      string
	anon    string
	ext     string // identifies the visitor with this external id
	batches [][]obj
}

func makeSession(start int64, anon string, nBatches int) session {
	s := session{id: fmt.Sprintf("0193%04x-0000-7000-8000-%012x", start%65536, start), anon: anon}
	ts := start
	for seq := range nBatches {
		var evs []obj
		if seq == 0 {
			evs = append(evs,
				obj{"type": 4, "timestamp": ts, "data": obj{"href": "https://shop.acme.dev/", "width": 1440, "height": 900}},
				obj{"type": 2, "timestamp": ts + 1, "data": obj{"node": obj{"type": 0, "id": 1, "childNodes": []any{
					obj{"type": 2, "id": 2, "tagName": "html", "attributes": obj{}, "childNodes": []any{
						obj{"type": 3, "id": 3, "textContent": "Hello ünïcode"}}}}}, "initialOffset": obj{"left": 0, "top": 0}}},
			)
		}
		for i := range 5 {
			ts += 100
			evs = append(evs, obj{"type": 3, "timestamp": ts, "data": obj{"source": 1, "positions": []any{obj{"x": i, "y": seq, "id": 2, "timeOffset": 0}}}})
		}
		evs = append(evs, obj{"type": 5, "timestamp": ts + 1, "data": obj{"tag": "console", "payload": obj{"level": "log", "text": fmt.Sprintf("batch %d", seq)}}})
		ts += 1000
		s.batches = append(s.batches, evs)
	}
	return s
}

func (s session) body(t *testing.T, seq int, start int64) []byte {
	t.Helper()
	evs := s.batches[seq]
	raw, _ := json.Marshal(evs)
	var gz bytes.Buffer
	w := gzip.NewWriter(&gz)
	w.Write(raw)
	w.Close()
	first, _ := evs[0]["timestamp"].(int64)
	last, _ := evs[len(evs)-1]["timestamp"].(int64)
	m := envelope.Meta{V: 1, SessionID: s.id, WindowID: "w", Seq: int64(seq), AnonymousID: s.anon, StartedAt: start,
		FirstTs: first, LastTs: last, URL: "https://shop.acme.dev/p", Path: fmt.Sprintf("/page-%d", seq),
		Referrer: "https://google.com/", Viewport: envelope.Viewport{W: 1440, H: 900}, Timezone: "Africa/Lagos",
		Release: "v1.2.3", Counts: envelope.Counts{Events: len(evs), Clicks: 1, Pageviews: 1}, Paths: []string{fmt.Sprintf("/page-%d", seq)}}
	if s.anon == "anon-identified" {
		m.Identity = &envelope.Identity{ID: "user-42", Email: "ada@example.com", Name: "Ada"}
	}
	if s.ext != "" {
		m.Identity = &envelope.Identity{ID: s.ext}
	}
	b, err := envelope.Encode(m, gz.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func (s session) all(from int) []any {
	var out []any
	for _, b := range s.batches[from:] {
		for _, e := range b {
			raw, _ := json.Marshal(e)
			var v any
			json.Unmarshal(raw, &v)
			out = append(out, v)
		}
	}
	return out
}

func postBatch(t *testing.T, base, key string, body []byte, want int) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, base+"/i/v1/batch?key="+key, bytes.NewReader(body))
	req.Header.Set("Content-Type", "text/plain;charset=UTF-8")
	req.Header.Set("Origin", "https://shop.acme.dev")
	req.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != want {
		t.Fatalf("batch: status %d, want %d", res.StatusCode, want)
	}
	if res.Header.Get("Access-Control-Allow-Origin") != "*" {
		t.Fatal("batch response lacks CORS")
	}
}

type eventsResponse struct {
	Events   []any `json:"events"`
	LastSeq  int64 `json:"lastSeq"`
	Complete bool  `json:"complete"`
}

func TestEndToEnd(t *testing.T) { endToEnd(t, testConfig(t), "sqlite") }

func TestEndToEndPostgres(t *testing.T) {
	endToEnd(t, testConfigWith(t, postgresURL(t)), "postgres")
}

func endToEnd(t *testing.T, cfg config.Config, driver string) {
	ctx := context.Background()
	a, err := New(ctx, cfg, "test", "abc", quietLog())
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	srv := httptest.NewServer(a.Handler())
	defer srv.Close()
	owner := newClient(t, srv.URL)

	var status obj
	owner.do("GET", "/api/v1/auth/status", nil, 200, &status)
	if status["hasUsers"] != false || status["signups"] != "open" {
		t.Fatalf("status %v", status)
	}
	owner.do("GET", "/api/v1/auth/me", nil, 401, nil)
	owner.do("POST", "/api/v1/auth/signup", obj{"name": "Ada", "email": "ada@acme.dev", "password": "short"}, 400, nil)
	var me struct {
		User struct{ ID, Role string }
		Org  struct{ ID, Name string }
	}
	owner.do("POST", "/api/v1/auth/signup", obj{"name": "Ada", "email": "Ada@Acme.dev", "password": "correct horse", "orgName": "Acme"}, 201, &me)
	if me.User.Role != "owner" || me.Org.Name != "Acme" {
		t.Fatalf("signup %+v", me)
	}
	newClient(t, srv.URL).do("POST", "/api/v1/auth/signup", obj{"name": "Eve", "email": "ada@acme.dev", "password": "correct horse"}, 409, nil)
	owner.do("GET", "/api/v1/auth/me", nil, 200, nil)

	var proj struct {
		ID, PublicKey, Slug string
		Stats               struct{ Series []int }
	}
	owner.do("POST", "/api/v1/projects", obj{"name": "Acme Shop", "origin": "https://shop.acme.dev", "platform": "react"}, 201, &proj)
	if !strings.HasPrefix(proj.PublicKey, "km_pub_") || len(proj.PublicKey) != 23 || proj.Slug != "acme-shop" || len(proj.Stats.Series) != 30 {
		t.Fatalf("project %+v", proj)
	}

	// The SDK side.
	var sdk obj
	res, _ := http.Get(srv.URL + "/i/v1/config?key=" + proj.PublicKey)
	json.NewDecoder(res.Body).Decode(&sdk)
	res.Body.Close()
	if sdk["recording"] != true || sdk["privacy"].(obj)["maskAllInputs"] != true {
		t.Fatalf("config %v", sdk)
	}
	res, _ = http.Get(srv.URL + "/i/v1/config?key=km_pub_0000000000000000")
	json.NewDecoder(res.Body).Decode(&sdk)
	res.Body.Close()
	if sdk["recording"] != false {
		t.Fatalf("unknown key config %v", sdk)
	}
	req, _ := http.NewRequest(http.MethodOptions, srv.URL+"/i/v1/batch?key="+proj.PublicKey, nil)
	req.Header.Set("Origin", "https://shop.acme.dev")
	req.Header.Set("Access-Control-Request-Method", "POST")
	res, _ = http.DefaultClient.Do(req)
	res.Body.Close()
	if res.StatusCode != 204 || !strings.Contains(res.Header.Get("Access-Control-Allow-Methods"), "POST") {
		t.Fatalf("preflight %d %v", res.StatusCode, res.Header)
	}

	start := time.Now().Add(-10 * time.Minute).UnixMilli()
	s1, s2 := makeSession(start, "anon-identified", 3), makeSession(start+5000, "anon-2", 2)
	for seq := range 3 {
		postBatch(t, srv.URL, proj.PublicKey, s1.body(t, seq, start), 204)
	}
	postBatch(t, srv.URL, proj.PublicKey, s1.body(t, 1, start), 204) // a retried batch
	for seq := range 2 {
		postBatch(t, srv.URL, proj.PublicKey, s2.body(t, seq, start+5000), 204)
	}
	postBatch(t, srv.URL, proj.PublicKey, []byte("garbage"), 400)
	postBatch(t, srv.URL, "km_pub_0000000000000000", s1.body(t, 0, start), 403)
	postBatch(t, srv.URL, proj.PublicKey, make([]byte, 6<<20), 413)
	if err := a.Flusher.Flush(ctx); err != nil {
		t.Fatal(err)
	}

	type recording struct {
		ID, Entry, Exit, Viewport string
		Clicks, Pages             int
		Seen, Starred, Live       bool
		Visitor                   struct {
			ID, City, Country, Browser, OS, Device string
			Email                                  *string
		}
	}
	var list struct {
		Items  []recording
		Total  int
		Counts struct{ All, Unwatched, Starred int }
	}
	owner.do("GET", "/api/v1/projects/"+proj.ID+"/recordings", nil, 200, &list)
	if list.Total != 2 || list.Counts.Unwatched != 2 {
		t.Fatalf("list %+v", list)
	}
	r1 := list.Items[1]
	if r1.ID != s1.id || r1.Clicks != 3 || r1.Pages != 3 || r1.Entry != "/page-0" || r1.Exit != "/page-2" ||
		r1.Viewport != "1440 × 900" || r1.Visitor.City != "Lagos" || r1.Visitor.Country != "Nigeria" ||
		r1.Visitor.Browser != "Chrome" || r1.Visitor.OS != "macOS" || r1.Visitor.Email == nil {
		t.Fatalf("recording %+v", r1)
	}

	readEvents := func(s session, after int64) eventsResponse {
		var ev eventsResponse
		owner.do("GET", fmt.Sprintf("/api/v1/projects/%s/recordings/%s/events?after=%d", proj.ID, s.id, after), nil, 200, &ev)
		return ev
	}
	for _, s := range []session{s1, s2} {
		ev := readEvents(s, -1)
		if !reflect.DeepEqual(ev.Events, s.all(0)) {
			t.Fatalf("live events of %s differ:\n got %v\nwant %v", s.id, ev.Events, s.all(0))
		}
		if ev.LastSeq != int64(len(s.batches)-1) || !ev.Complete {
			t.Fatalf("live events meta %d %v", ev.LastSeq, ev.Complete)
		}
	}
	if ev := readEvents(s1, 0); !reflect.DeepEqual(ev.Events, s1.all(1)) {
		t.Fatalf("events after 0 differ")
	}

	rec := "/api/v1/projects/" + proj.ID + "/recordings/" + s1.id
	var flagged recording
	owner.do("PATCH", rec, obj{"seen": true, "starred": true}, 200, &flagged)
	if !flagged.Seen || !flagged.Starred {
		t.Fatalf("flags %+v", flagged)
	}
	var detail struct{ NewerID, OlderID *string }
	owner.do("GET", rec, nil, 200, &detail)
	if detail.NewerID == nil || *detail.NewerID != s2.id || detail.OlderID != nil {
		t.Fatalf("neighbors %+v", detail)
	}

	sealed, err := a.Worker.Seal(ctx, 0)
	if err != nil || sealed != 2 {
		t.Fatalf("sealed %d, %v", sealed, err)
	}
	for _, s := range []session{s1, s2} {
		ev := readEvents(s, -1)
		if !reflect.DeepEqual(ev.Events, s.all(0)) {
			t.Fatalf("sealed events of %s differ", s.id)
		}
		if ev.LastSeq != int64(len(s.batches)-1) || !ev.Complete {
			t.Fatalf("sealed events meta %d %v", ev.LastSeq, ev.Complete)
		}
	}
	var objects []string
	for o, err := range a.Blob.List(ctx, "") {
		if err != nil {
			t.Fatal(err)
		}
		objects = append(objects, o.Key)
	}
	if len(objects) != 2 || !strings.HasPrefix(objects[0], "live/") || !strings.HasPrefix(objects[1], "sealed/30d/"+proj.ID+"/") {
		t.Fatalf("objects %v", objects)
	}

	var overview struct {
		Totals struct{ Recordings, Today int }
		Days   []struct{ Date string }
	}
	owner.do("GET", "/api/v1/projects/"+proj.ID+"/overview?days=14", nil, 200, &overview)
	if overview.Totals.Recordings != 2 || len(overview.Days) != 14 {
		t.Fatalf("overview %+v", overview)
	}
	var visitors struct {
		Items  []struct{ ID string }
		Counts struct{ Identified int }
	}
	owner.do("GET", "/api/v1/projects/"+proj.ID+"/visitors?kind=anonymous", nil, 200, &visitors)
	if len(visitors.Items) != 1 {
		t.Fatalf("visitors %+v", visitors)
	}
	var vd struct {
		Activity   []obj
		Recordings []obj
		Stats      struct{ Sessions int }
	}
	owner.do("GET", "/api/v1/projects/"+proj.ID+"/visitors/"+visitors.Items[0].ID, nil, 200, &vd)
	if len(vd.Activity) != 84 || len(vd.Recordings) != 1 || vd.Stats.Sessions != 1 {
		t.Fatalf("visitor detail %+v", vd)
	}
	owner.do("DELETE", "/api/v1/projects/"+proj.ID+"/visitors/"+visitors.Items[0].ID, nil, 204, nil)
	owner.do("GET", "/api/v1/projects/"+proj.ID+"/recordings", nil, 200, &list)
	if list.Total != 1 {
		t.Fatalf("after visitor delete: %d", list.Total)
	}
	var cleaned struct{ Deleted int }
	owner.do("POST", "/api/v1/storage/cleanup", nil, 200, &cleaned)
	if cleaned.Deleted != 1 {
		t.Fatalf("cleanup %+v", cleaned)
	}
	var storage struct {
		Recordings int
		Ages       []obj
	}
	owner.do("GET", "/api/v1/storage", nil, 200, &storage)
	if storage.Recordings != 1 || len(storage.Ages) != 5 {
		t.Fatalf("storage %+v", storage)
	}
	var inst struct {
		Database struct{ Driver string }
		Health   []struct{ Name, Status string }
	}
	owner.do("GET", "/api/v1/instance", nil, 200, &inst)
	if inst.Database.Driver != driver || len(inst.Health) != 4 {
		t.Fatalf("instance %+v", inst)
	}
	for _, h := range inst.Health {
		if h.Status != "healthy" {
			t.Fatalf("health %+v", inst.Health)
		}
	}

	t.Run("roles and invitations", func(t *testing.T) {
		var inv struct {
			Link       string
			Invitation struct{ ID string }
		}
		owner.do("POST", "/api/v1/invitations", obj{"email": "vic@acme.dev", "role": "viewer"}, 201, &inv)
		token := inv.Link[strings.LastIndex(inv.Link, "/")+1:]
		if !strings.HasPrefix(inv.Link, "http://localhost:8700/invite/") {
			t.Fatalf("link %s", inv.Link)
		}
		var pending []struct{ Link string }
		owner.do("GET", "/api/v1/invitations", nil, 200, &pending)
		if len(pending) != 1 || pending[0].Link != inv.Link {
			t.Fatalf("pending %+v", pending)
		}
		viewer := newClient(t, srv.URL)
		var look obj
		viewer.do("GET", "/api/v1/invitations/lookup/"+token, nil, 200, &look)
		if look["orgName"] != "Acme" || look["role"] != "viewer" {
			t.Fatalf("lookup %v", look)
		}
		viewer.do("GET", "/api/v1/invitations/lookup/nope", nil, 404, nil)
		var vme struct{ User struct{ ID string } }
		viewer.do("POST", "/api/v1/invitations/accept", obj{"token": token, "name": "Vic", "password": "viewer pass"}, 201, &vme)
		viewer.do("POST", "/api/v1/invitations/accept", obj{"token": token, "name": "Vic", "password": "viewer pass"}, 404, nil)

		var projects []obj
		viewer.do("GET", "/api/v1/projects", nil, 200, &projects)
		if len(projects) != 0 {
			t.Fatalf("viewer sees %d projects before being added", len(projects))
		}
		viewer.do("GET", "/api/v1/projects/"+proj.ID, nil, 404, nil)
		viewer.do("POST", "/api/v1/projects/"+proj.ID+"/members", obj{"userId": vme.User.ID, "role": "member"}, 404, nil)
		owner.do("POST", "/api/v1/projects/"+proj.ID+"/members", obj{"userId": vme.User.ID, "role": "member"}, 201, nil)
		viewer.do("GET", "/api/v1/projects", nil, 200, &projects)
		if len(projects) != 1 {
			t.Fatalf("viewer sees %d projects", len(projects))
		}
		// An org viewer stays a viewer in the project, whatever the project role says.
		viewer.do("PATCH", rec, obj{"starred": false}, 403, nil)
		viewer.do("PATCH", rec, obj{"seen": false}, 200, nil)
		viewer.do("DELETE", rec, nil, 403, nil)
		viewer.do("PATCH", "/api/v1/projects/"+proj.ID+"/settings", obj{"capture": obj{"sampleRate": 50}}, 403, nil)
		viewer.do("POST", "/api/v1/projects", obj{"name": "X", "origin": "https://x.dev", "platform": "vue"}, 403, nil)
		viewer.do("PATCH", "/api/v1/members/"+me.User.ID, obj{"role": "viewer"}, 403, nil)
		viewer.do("POST", "/api/v1/storage/cleanup", nil, 403, nil)

		owner.do("PATCH", "/api/v1/members/"+vme.User.ID, obj{"role": "admin"}, 200, nil)
		viewer.do("PATCH", "/api/v1/projects/"+proj.ID+"/settings", obj{"capture": obj{"sampleRate": 50}}, 200, nil)
		viewer.do("PATCH", "/api/v1/members/"+me.User.ID, obj{"role": "viewer"}, 403, nil) // admins cannot touch owners
		owner.do("PATCH", "/api/v1/members/"+me.User.ID, obj{"role": "admin"}, 409, nil)   // the last owner stays
		var settings struct {
			Capture struct {
				SampleRate int
				Console    bool
			}
			Retention struct{ Days int }
		}
		owner.do("GET", "/api/v1/projects/"+proj.ID+"/settings", nil, 200, &settings)
		if settings.Capture.SampleRate != 50 || !settings.Capture.Console || settings.Retention.Days != 30 {
			t.Fatalf("settings %+v", settings)
		}
		owner.do("PATCH", "/api/v1/projects/"+proj.ID+"/settings", obj{"retention": obj{"days": 12}}, 400, nil)
	})

	t.Run("api tokens", func(t *testing.T) {
		var created struct {
			Token  struct{ ID, Prefix string }
			Secret string
		}
		owner.do("POST", "/api/v1/tokens", obj{"name": "ci", "access": "read", "expiresInDays": nil}, 201, &created)
		if !strings.HasPrefix(created.Secret, "km_sec_") || !strings.HasPrefix(created.Secret, created.Token.Prefix) {
			t.Fatalf("token %+v", created)
		}
		bot := &client{t: t, base: srv.URL, http: http.DefaultClient, auth: created.Secret}
		bot.do("GET", "/api/v1/projects/"+proj.ID+"/recordings", nil, 200, nil)
		bot.do("PATCH", rec, obj{"seen": true}, 403, nil)
		bot.auth = "km_sec_wrong"
		bot.do("GET", "/api/v1/projects", nil, 401, nil)
		owner.do("DELETE", "/api/v1/tokens/"+created.Token.ID, nil, 204, nil)
	})

	t.Run("origins", func(t *testing.T) {
		owner.do("PUT", "/api/v1/projects/"+proj.ID+"/origins", obj{"origins": []string{"https://other.dev"}}, 200, nil)
		postBatch(t, srv.URL, proj.PublicKey, s1.body(t, 0, start), 403)
		owner.do("PUT", "/api/v1/projects/"+proj.ID+"/origins", obj{"origins": []string{"https://*.acme.dev"}}, 200, nil)
		postBatch(t, srv.URL, proj.PublicKey, s1.body(t, 0, start), 204)
	})

	t.Run("loadgen", func(t *testing.T) {
		owner.do("PUT", "/api/v1/projects/"+proj.ID+"/origins", obj{"origins": []string{}}, 200, nil)
		rep, err := loadgen.Run(ctx, loadgen.Options{Host: srv.URL, Key: proj.PublicKey, Sessions: 4, Concurrency: 2,
			Batches: 3, Interval: 5 * time.Millisecond}, io.Discard)
		if err != nil {
			t.Fatal(err)
		}
		if rep.Failed != 0 || rep.Batches != 12 || rep.Sessions != 4 {
			t.Fatalf("loadgen report:\n%s", rep)
		}
	})

	t.Run("logout", func(t *testing.T) {
		owner.do("POST", "/api/v1/auth/logout", nil, 204, nil)
		owner.do("GET", "/api/v1/auth/me", nil, 401, nil)
		owner.do("POST", "/api/v1/auth/login", obj{"email": "ada@acme.dev", "password": "wrong password"}, 401, nil)
		owner.do("POST", "/api/v1/auth/login", obj{"email": "ADA@acme.dev", "password": "correct horse"}, 200, nil)
		var sessions []struct {
			Current bool
			Browser string
		}
		owner.do("GET", "/api/v1/me/sessions", nil, 200, &sessions)
		if len(sessions) != 1 || !sessions[0].Current {
			t.Fatalf("sessions %+v", sessions)
		}
	})

	t.Run("static", func(t *testing.T) {
		for path, want := range map[string]string{"/": "no-cache", "/projects/abc/recordings": "no-cache", "/kimmi.js": "public, max-age=300"} {
			res, err := http.Get(srv.URL + path)
			if err != nil {
				t.Fatal(err)
			}
			res.Body.Close()
			if res.StatusCode != 200 || res.Header.Get("Cache-Control") != want {
				t.Fatalf("%s: %d %q", path, res.StatusCode, res.Header.Get("Cache-Control"))
			}
		}
		owner.do("GET", "/api/v1/nope", nil, 404, nil)
	})
}

// TestShutdownFlushes checks that a graceful stop writes buffered batches.
func TestShutdownFlushes(t *testing.T) {
	cfg := testConfig(t)
	ctx, cancel := context.WithCancel(context.Background())
	a, err := New(ctx, cfg, "test", "abc", quietLog())
	if err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- a.Run(ctx, ln) }()
	base := "http://" + ln.Addr().String()
	c := newClient(t, base)
	c.do("POST", "/api/v1/auth/signup", obj{"name": "Ada", "email": "ada@acme.dev", "password": "correct horse"}, 201, nil)
	var proj struct{ ID, PublicKey string }
	c.do("POST", "/api/v1/projects", obj{"name": "Shop", "origin": "https://shop.acme.dev", "platform": "next"}, 201, &proj)
	start := time.Now().UnixMilli()
	s := makeSession(start, "anon-1", 1)
	postBatch(t, base, proj.PublicKey, s.body(t, 0, start), 204)
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}

	b, err := New(context.Background(), cfg, "test", "abc", quietLog())
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	page, err := b.Store.ListRecordings(context.Background(), store.RecordingQuery{ProjectID: proj.ID})
	if err != nil || page.Total != 1 {
		t.Fatalf("after restart: %d recordings, %v", page.Total, err)
	}
}
