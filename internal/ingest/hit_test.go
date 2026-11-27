package ingest

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/dimmihq/kimmi/internal/blob"
	"github.com/dimmihq/kimmi/internal/settings"
	"github.com/dimmihq/kimmi/internal/store"
)

func newHitHandler(t *testing.T, change func(*settings.Settings)) (*fakeStore, *Handler, *http.ServeMux) {
	t.Helper()
	b, _ := blob.NewLocal(t.TempDir())
	st := &fakeStore{}
	set := settings.Default()
	if change != nil {
		change(&set)
	}
	cache := &Cache{byKey: map[string]*Project{"km_pub_k": {ID: "p", OrgID: "o", Settings: set}}}
	h := &Handler{Cache: cache, Flusher: NewFlusher(b, st, "n", &Stats{}, quiet(), Limits{Buffer: 1 << 20}),
		Stats: &Stats{}, Salts: &Salts{Store: st}, Feedback: st}
	mux := http.NewServeMux()
	h.Register(mux)
	return st, h, mux
}

func postTo(mux http.Handler, path, body, remote, agent string) *httptest.ResponseRecorder {
	req := httptest.NewRequest("POST", path+"?key=km_pub_k", strings.NewReader(body))
	req.RemoteAddr = remote
	req.Header.Set("User-Agent", agent)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

const chrome = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"

func TestHitBecomesVisitAndEvents(t *testing.T) {
	st, h, mux := newHitHandler(t, nil)
	body := `{"v":1,"visitId":"v1","anonymousId":"anon","startedAt":1,"url":"https://shop.dev/pricing",
		"landing":"https://shop.dev/?utm_source=News&utm_medium=email&utm_campaign=Spring","referrer":"https://www.google.com/",
		"viewport":{"w":1280,"h":800},"language":"en-GB","timezone":"Africa/Lagos","release":"v2",
		"events":[{"t":0,"k":"page","p":"/pricing","l":"Pricing"},{"k":"track","n":"signup","v":49,"d":{"plan":"pro"}},
			{"k":"error","l":"TypeError: x is undefined at 12","d":{"stack":"TypeError\n    at pay (https://shop.dev/app.js:10:5)"}},
			{"k":"click","n":"button.buy","x":20000,"y":-4,"w":1280},{"k":"nonsense"},{"k":"track"}]}`
	if rec := postTo(mux, "/i/v1/hit", body, "198.51.100.7:1", chrome); rec.Code != 204 {
		t.Fatalf("status %d", rec.Code)
	}
	if err := h.Flusher.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(st.hits) != 1 {
		t.Fatalf("%d hits stored", len(st.hits))
	}
	got := st.hits[0]
	if got.VisitorKey != "a:anon" || got.Cookieless || got.ProjectID != "p" || got.OrgID != "o" {
		t.Fatalf("identity: %+v", got)
	}
	if got.Referrer != "google.com" || got.Channel != "Email" || got.UTMSource != "news" || got.UTMCampaign != "Spring" {
		t.Fatalf("source: %+v", got)
	}
	if got.CountryCode != "NG" || got.Browser != "Chrome" || got.Device != "Desktop" || got.Language != "en-GB" || got.Release != "v2" {
		t.Fatalf("place and agent: %+v", got)
	}
	if len(got.Events) != 4 {
		t.Fatalf("%d events kept, want 4 (an unknown kind and a nameless track are dropped)", len(got.Events))
	}
	page, track, fail, click := got.Events[0], got.Events[1], got.Events[2], got.Events[3]
	if page.Kind != store.KindPage || page.Path != "/pricing" || page.Ts != got.At {
		t.Fatalf("page: %+v (a zero timestamp becomes the arrival time)", page)
	}
	if track.Name != "signup" || track.Value != 49 || track.Props != `{"plan":"pro"}` {
		t.Fatalf("track: %+v", track)
	}
	if len(fail.Name) != 16 || fail.Label == "" {
		t.Fatalf("error: %+v", fail)
	}
	if click.X != 10000 || click.Y != 0 {
		t.Fatalf("click is not clamped: %+v", click)
	}
	if h.Flusher.Buffered() != 0 {
		t.Fatalf("%d bytes still counted after the flush", h.Flusher.Buffered())
	}
}

func TestCookielessHitIsHashedPerDayAddressAndAgent(t *testing.T) {
	st, h, mux := newHitHandler(t, nil)
	body := `{"v":1,"visitId":"v1","anonymousId":"","events":[{"k":"page","p":"/"}]}`
	for _, c := range []struct{ remote, agent string }{
		{"198.51.100.7:1", chrome}, {"198.51.100.7:2", chrome}, {"198.51.100.8:1", chrome}, {"198.51.100.7:1", "Other/1"},
	} {
		if rec := postTo(mux, "/i/v1/hit", body, c.remote, c.agent); rec.Code != 204 {
			t.Fatalf("status %d", rec.Code)
		}
	}
	_ = h.Flusher.Flush(context.Background())
	keys := make([]string, len(st.hits))
	for i, hit := range st.hits {
		if !hit.Cookieless || !strings.HasPrefix(hit.VisitorKey, "h:") || len(hit.VisitorKey) != 34 {
			t.Fatalf("hit %d: %+v", i, hit)
		}
		if strings.Contains(hit.VisitorKey, "198") {
			t.Fatal("the address leaks into the key")
		}
		keys[i] = hit.VisitorKey
	}
	if keys[0] != keys[1] || keys[0] == keys[2] || keys[0] == keys[3] {
		t.Fatalf("keys %v: same address and agent must match, others must differ", keys)
	}
}

func TestHitRefusals(t *testing.T) {
	_, _, mux := newHitHandler(t, nil)
	for name, c := range map[string]struct {
		body string
		want int
	}{
		"not json":        {"nope", 400},
		"wrong version":   {`{"v":2,"visitId":"v"}`, 400},
		"no visit":        {`{"v":1}`, 400},
		"too many events": {`{"v":1,"visitId":"v","events":[` + strings.TrimSuffix(strings.Repeat(`{"k":"page"},`, 201), ",") + `]}`, 400},
		"too large":       {`{"v":1,"visitId":"v","url":"` + strings.Repeat("a", MaxHitBytes) + `"}`, 413},
	} {
		if rec := postTo(mux, "/i/v1/hit", c.body, "198.51.100.7:1", chrome); rec.Code != c.want {
			t.Errorf("%s: status %d, want %d", name, rec.Code, c.want)
		}
	}
	_, _, off := newHitHandler(t, func(s *settings.Settings) { s.Analytics.Enabled = false })
	if rec := postTo(off, "/i/v1/hit", `{"v":1,"visitId":"v"}`, "198.51.100.7:1", chrome); rec.Code != 403 {
		t.Fatalf("analytics off: status %d, want 403", rec.Code)
	}
}

func TestHitsSurviveAFailedWrite(t *testing.T) {
	st, h, mux := newHitHandler(t, nil)
	st.failHits = errors.New("database is away")
	postTo(mux, "/i/v1/hit", `{"v":1,"visitId":"v1","anonymousId":"a","events":[{"k":"page","p":"/"}]}`, "198.51.100.7:1", chrome)
	if err := h.Flusher.Flush(context.Background()); err == nil {
		t.Fatal("the flush should fail")
	}
	if h.Flusher.Buffered() == 0 {
		t.Fatal("a failed hit must stay counted in the buffer")
	}
	st.failHits = nil
	if err := h.Flusher.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(st.hits) != 1 || h.Flusher.Buffered() != 0 {
		t.Fatalf("after the retry: %d hits, %d bytes buffered", len(st.hits), h.Flusher.Buffered())
	}
}

func TestClassify(t *testing.T) {
	for _, c := range []struct{ landing, referrer, channel, source string }{
		{"https://a.dev/", "", "Direct", ""},
		{"https://a.dev/", "https://a.dev/pricing", "Direct", ""},
		{"https://a.dev/", "https://www.google.co.uk/search", "Search", "google.co.uk"},
		{"https://a.dev/", "https://t.co/x", "Social", "t.co"},
		{"https://a.dev/", "https://chatgpt.com/", "AI", "chatgpt.com"},
		{"https://a.dev/", "https://blog.example.org/post", "Referral", "blog.example.org"},
		{"https://a.dev/?gclid=1", "https://www.google.com/", "Paid", "google.com"},
		{"https://a.dev/?utm_source=bing&utm_medium=cpc", "", "Paid", "bing"},
		{"https://a.dev/?utm_source=partner", "", "Campaign", "partner"},
		{"https://a.dev/?utm_medium=email", "https://mail.example.com/", "Email", "mail.example.com"},
		{"https://a.dev/", "https://notgoogle.example/", "Referral", "notgoogle.example"},
	} {
		got := classify("https://a.dev/now", c.landing, c.referrer)
		if got.channel != c.channel || got.referrer != c.source {
			t.Errorf("classify(%q, %q) = %s from %q, want %s from %q", c.landing, c.referrer, got.channel, got.referrer, c.channel, c.source)
		}
	}
}

func TestFingerprintGroupsOneBug(t *testing.T) {
	a := fingerprint("Cannot read item 12 of 40", `{"stack":"Error\n    at pay (https://a.dev/app.js?v=3:10:5)\n    at b"}`)
	b := fingerprint("Cannot read item 7 of 9", `{"stack":"Error\n    at pay (https://a.dev/app.js?v=4:88:1)\n    at c"}`)
	c := fingerprint("Cannot read item 7 of 9", `{"stack":"Error\n    at refund (https://a.dev/app.js:88:1)"}`)
	if a != b {
		t.Fatal("numbers, line numbers and query strings must not split a group")
	}
	if a == c {
		t.Fatal("another function is another group")
	}
}

func TestFeedbackIsStored(t *testing.T) {
	st, h, mux := newHitHandler(t, nil)
	var told []store.Feedback
	h.OnFeedback = func(f store.Feedback) { told = append(told, f) }
	if rec := postTo(mux, "/i/v1/feedback", `{"v":1,"visitId":"v1","anonymousId":"a","path":"/cart","text":"  The button does nothing ","email":"me@x.dev"}`, "198.51.100.7:1", chrome); rec.Code != 204 {
		t.Fatalf("status %d", rec.Code)
	}
	if len(st.feedback) != 1 || len(told) != 1 {
		t.Fatalf("%d stored, %d announced", len(st.feedback), len(told))
	}
	f := st.feedback[0]
	if f.Body != "The button does nothing" || f.Path != "/cart" || f.VisitID != "v1" || f.VisitorKey != "a:a" || f.Email != "me@x.dev" || f.ProjectID != "p" {
		t.Fatalf("feedback: %+v", f)
	}
	if rec := postTo(mux, "/i/v1/feedback", `{"v":1,"visitId":"v1","text":"   "}`, "198.51.100.7:1", chrome); rec.Code != 400 {
		t.Fatalf("empty text: status %d", rec.Code)
	}
}
