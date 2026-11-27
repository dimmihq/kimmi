package app

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dimmihq/kimmi/internal/config"
)

const testAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

func postHit(t *testing.T, base, route, key string, body obj, want int) {
	t.Helper()
	raw, _ := json.Marshal(body)
	req, _ := http.NewRequest(http.MethodPost, base+route+"?key="+key, strings.NewReader(string(raw)))
	req.Header.Set("Content-Type", "text/plain;charset=UTF-8")
	req.Header.Set("Origin", "https://shop.acme.dev")
	req.Header.Set("User-Agent", testAgent)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != want {
		t.Fatalf("%s: status %d, want %d", route, res.StatusCode, want)
	}
}

// hooks records webhook deliveries.
type hooks struct {
	mu   sync.Mutex
	got  []obj
	sigs []string
	raw  [][]byte
}

func (h *hooks) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	var v obj
	_ = json.Unmarshal(body, &v)
	h.mu.Lock()
	h.got, h.sigs, h.raw = append(h.got, v), append(h.sigs, r.Header.Get("X-Kimmi-Signature")), append(h.raw, body)
	h.mu.Unlock()
	w.WriteHeader(http.StatusNoContent)
}

func (h *hooks) wait(t *testing.T, event string) obj {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		h.mu.Lock()
		for _, v := range h.got {
			if v["event"] == event {
				h.mu.Unlock()
				return v
			}
		}
		h.mu.Unlock()
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("no %s delivery arrived", event)
	return nil
}

func TestAnalytics(t *testing.T) { analyticsEndToEnd(t, testConfig(t)) }

func TestAnalyticsPostgres(t *testing.T) { analyticsEndToEnd(t, testConfigWith(t, postgresURL(t))) }

func analyticsEndToEnd(t *testing.T, cfg config.Config) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	a, err := New(ctx, cfg, "test", "abc", quietLog())
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	go a.Notify.Run(ctx)
	srv := httptest.NewServer(a.Handler())
	defer srv.Close()
	receiver := &hooks{}
	hook := httptest.NewServer(receiver)
	defer hook.Close()

	owner := newClient(t, srv.URL)
	owner.do("POST", "/api/v1/auth/signup", obj{"name": "Ada", "email": "ada@acme.dev", "password": "correct horse", "orgName": "Acme"}, 201, nil)
	var proj struct{ ID, PublicKey string }
	owner.do("POST", "/api/v1/projects", obj{"name": "Shop", "origin": "https://shop.acme.dev", "platform": "script"}, 201, &proj)
	p := "/api/v1/projects/" + proj.ID

	// The SDK learns that analytics is on.
	var conf struct {
		Analytics struct{ Enabled, Cookieless, AutoEvents, Heatmaps bool }
		Feedback  struct{ Button string }
	}
	res, err := http.Get(srv.URL + "/i/v1/config?key=" + proj.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	json.NewDecoder(res.Body).Decode(&conf)
	res.Body.Close()
	if !conf.Analytics.Enabled || conf.Analytics.Cookieless || !conf.Analytics.Heatmaps || conf.Feedback.Button != "hidden" {
		t.Fatalf("config: %+v", conf)
	}

	// Goals, a funnel and the webhook are project settings.
	var set struct {
		Analytics struct {
			Goals   []struct{ ID, Name string }
			Funnels []struct{ ID string }
		}
		Alerts struct{ WebhookURL, Secret string }
	}
	owner.do("PATCH", p+"/settings", obj{"analytics": obj{"goals": []obj{{"name": "", "kind": "page", "value": "/thanks"}}}}, 400, nil)
	owner.do("PATCH", p+"/settings", obj{"alerts": obj{"webhookUrl": "ftp://nope"}}, 400, nil)
	owner.do("PATCH", p+"/settings", obj{"feedback": obj{"button": "top"}}, 400, nil)
	owner.do("PATCH", p+"/settings", obj{
		"analytics": obj{
			"goals":   []obj{{"name": "Signed up", "kind": "event", "value": "signup"}, {"name": "Thanks page", "kind": "page", "value": "/thanks"}},
			"funnels": []obj{{"name": "Checkout", "steps": []obj{{"kind": "page", "value": "/"}, {"kind": "page", "value": "/pricing"}, {"kind": "event", "value": "signup"}}}},
		},
		"alerts": obj{"webhookUrl": hook.URL, "secret": "s3cret", "errorSpike": 2},
	}, 200, &set)
	if len(set.Analytics.Goals) != 2 || set.Analytics.Goals[0].ID == "" || len(set.Analytics.Funnels) != 1 || set.Analytics.Funnels[0].ID == "" {
		t.Fatalf("settings: %+v", set)
	}
	a.Cache.Invalidate(ctx)

	owner.do("POST", p+"/alerts/test", nil, 204, nil)
	test := receiver.wait(t, "test")
	if test["project"].(obj)["name"] != "Shop" {
		t.Fatalf("test delivery: %v", test)
	}
	receiver.mu.Lock()
	mac := hmac.New(sha256.New, []byte("s3cret"))
	mac.Write(receiver.raw[0])
	if receiver.sigs[0] != "sha256="+hex.EncodeToString(mac.Sum(nil)) {
		t.Fatal("the delivery is not signed with the secret")
	}
	receiver.mu.Unlock()

	// Three visits: one converts through the whole funnel and is recorded,
	// one stops at pricing and hits an error, one bounces without cookies.
	now := time.Now().UnixMilli()
	rec := makeSession(now-60_000, "anon-1", 1)
	rec.batches[0] = append(rec.batches[0],
		obj{"type": 5, "timestamp": now - 59_000, "data": obj{"tag": "identify", "payload": obj{"id": "user-42", "email": "ada@example.com"}}},
		obj{"type": 5, "timestamp": now - 58_000, "data": obj{"tag": "network", "payload": obj{"method": "GET", "url": "https://api.acme.dev/secret", "status": 200}}},
		obj{"type": 5, "timestamp": now - 57_000, "data": obj{"tag": "navigate", "payload": obj{"href": "https://shop.acme.dev/pricing", "path": "/pricing", "title": "Pricing"}}})
	postBatch(t, srv.URL, proj.PublicKey, rec.body(t, 0, now-60_000), 204)
	hit := func(visit, anon string, events ...obj) obj {
		return obj{"v": 1, "visitId": visit, "anonymousId": anon, "startedAt": now - 60_000, "url": "https://shop.acme.dev/pricing",
			"landing": "https://shop.acme.dev/?utm_source=news&utm_campaign=spring", "referrer": "https://www.google.com/",
			"viewport": obj{"w": 1440, "h": 900}, "language": "en-GB", "timezone": "Africa/Lagos", "release": "v2", "events": events}
	}
	postHit(t, srv.URL, "/i/v1/hit", proj.PublicKey, hit(rec.id, "anon-1",
		obj{"t": now - 50_000, "k": "page", "p": "/", "l": "Home"},
		obj{"t": now - 45_000, "k": "click", "p": "/", "n": "a.cta", "l": "Start", "x": 5020, "y": 318, "w": 1440},
		obj{"t": now - 44_000, "k": "leave", "p": "/", "v": 6000, "num": 80, "y": 2400, "w": 1440},
		obj{"t": now - 43_000, "k": "page", "p": "/pricing", "l": "Pricing"},
		obj{"t": now - 40_000, "k": "rage", "p": "/pricing", "n": "button.buy", "l": "Buy", "v": 4},
		obj{"t": now - 30_000, "k": "track", "p": "/pricing", "n": "signup", "v": 49, "d": obj{"plan": "pro"}},
		obj{"t": now - 29_000, "k": "vital", "p": "/", "n": "lcp", "v": 1800},
	), 204)
	boom := obj{"k": "error", "p": "/pricing", "l": "TypeError: price is undefined", "d": obj{"source": "app.js:10:5", "stack": "TypeError: price is undefined\n    at pay (https://shop.acme.dev/app.js:10:5)"}}
	boom1, boom2 := obj{"t": now - 20_000}, obj{"t": now - 19_000}
	for k, v := range boom {
		boom1[k], boom2[k] = v, v
	}
	postHit(t, srv.URL, "/i/v1/hit", proj.PublicKey, hit("visit-2", "anon-2",
		obj{"t": now - 25_000, "k": "page", "p": "/"}, obj{"t": now - 22_000, "k": "page", "p": "/pricing"}, boom1, boom2,
		obj{"t": now - 18_000, "k": "request", "p": "/pricing", "n": "POST api.acme.dev/cart", "v": 120, "num": 500},
	), 204)
	postHit(t, srv.URL, "/i/v1/hit", proj.PublicKey, hit("visit-3", "", obj{"t": now - 10_000, "k": "page", "p": "/"}), 204)
	postHit(t, srv.URL, "/i/v1/feedback", proj.PublicKey, obj{"v": 1, "visitId": rec.id, "anonymousId": "anon-1", "path": "/pricing", "text": "The buy button does nothing"}, 204)
	if err := a.Flusher.Flush(ctx); err != nil {
		t.Fatal(err)
	}

	var traffic struct {
		Totals  struct{ Visitors, Visits, Pageviews, Bounces, NewVisitors int }
		Sources []struct {
			Name     string
			Visitors int
		}
		Channels []struct{ Name string }
		Pages    []struct {
			Path   string
			Views  int
			Scroll int
		}
		Goals []struct {
			Name        string
			Conversions int
		}
		GoalSources []struct {
			Name  string
			Count int
		}
	}
	owner.do("GET", p+"/analytics?days=7&goal="+set.Analytics.Goals[0].ID, nil, 200, &traffic)
	if traffic.Totals.Visitors != 3 || traffic.Totals.Visits != 3 || traffic.Totals.Pageviews != 5 || traffic.Totals.Bounces != 1 {
		t.Fatalf("totals: %+v", traffic.Totals)
	}
	if len(traffic.Sources) != 1 || traffic.Sources[0].Name != "google.com" || traffic.Sources[0].Visitors != 3 || traffic.Channels[0].Name != "Search" {
		t.Fatalf("sources: %+v %+v", traffic.Sources, traffic.Channels)
	}
	if traffic.Pages[0].Path != "/" || traffic.Pages[0].Views != 3 || traffic.Pages[0].Scroll != 80 {
		t.Fatalf("pages: %+v", traffic.Pages)
	}
	if traffic.Goals[0].Conversions != 1 || traffic.Goals[1].Conversions != 0 || len(traffic.GoalSources) != 1 || traffic.GoalSources[0].Count != 1 {
		t.Fatalf("goals: %+v %+v", traffic.Goals, traffic.GoalSources)
	}
	var filtered struct{ Totals struct{ Visits int } }
	owner.do("GET", p+"/analytics?path=/pricing", nil, 200, &filtered)
	if filtered.Totals.Visits != 2 {
		t.Fatalf("visits that viewed /pricing: %d", filtered.Totals.Visits)
	}

	// The funnel, and who to watch at the step people leave.
	var funnels []struct {
		ID    string
		Steps []struct{ Visits, Dropped, Watchable int }
	}
	owner.do("GET", p+"/funnels", nil, 200, &funnels)
	if s := funnels[0].Steps; s[0].Visits != 3 || s[1].Visits != 2 || s[2].Visits != 1 || s[0].Dropped != 1 || s[1].Dropped != 1 {
		t.Fatalf("funnel: %+v", funnels)
	}
	var drop struct {
		Items  []struct{ ID string }
		Visits int
	}
	owner.do("GET", p+"/funnels/"+funnels[0].ID+"/dropoffs?step=1", nil, 200, &drop)
	if drop.Visits != 1 || len(drop.Items) != 0 {
		t.Fatalf("the visit that stopped at pricing was not recorded: %+v", drop)
	}
	owner.do("GET", p+"/funnels/nope/dropoffs", nil, 404, nil)

	// The error group, with the alert for a new kind of error.
	var groups []struct {
		Fingerprint, Message string
		Count, Visits        int
	}
	owner.do("GET", p+"/errors", nil, 200, &groups)
	if len(groups) != 1 || groups[0].Count != 2 || groups[0].Visits != 1 || !strings.Contains(groups[0].Message, "price") {
		t.Fatalf("errors: %+v", groups)
	}
	var detail struct {
		Occurrences []struct {
			VisitID  string
			Recorded bool
		}
	}
	owner.do("GET", p+"/errors/"+groups[0].Fingerprint, nil, 200, &detail)
	if len(detail.Occurrences) != 2 || detail.Occurrences[0].Recorded {
		t.Fatalf("occurrences: %+v", detail)
	}
	owner.do("GET", p+"/errors/unknown", nil, 404, nil)
	fresh := receiver.wait(t, "error.new")
	if fresh["data"].(obj)["fingerprint"] != groups[0].Fingerprint || !strings.Contains(fresh["url"].(string), "/errors/"+groups[0].Fingerprint) {
		t.Fatalf("new error delivery: %v", fresh)
	}
	receiver.wait(t, "error.spike")
	said := receiver.wait(t, "feedback.new")
	if said["text"] != "The buy button does nothing" {
		t.Fatalf("feedback delivery: %v", said)
	}

	var friction struct {
		Elements []struct{ Kind, Selector, Label string }
		Pages    []struct {
			Path         string
			Rage, Errors int
		}
	}
	owner.do("GET", p+"/friction", nil, 200, &friction)
	if len(friction.Elements) != 1 || friction.Elements[0].Selector != "button.buy" || friction.Pages[0].Path != "/pricing" || friction.Pages[0].Rage != 1 || friction.Pages[0].Errors != 1 {
		t.Fatalf("friction: %+v", friction)
	}
	var requests []struct {
		Name           string
		Failed, Status int
	}
	owner.do("GET", p+"/requests", nil, 200, &requests)
	if len(requests) != 1 || requests[0].Failed != 1 || requests[0].Status != 500 {
		t.Fatalf("requests: %+v", requests)
	}
	var vitals []struct {
		Path string
		LCP  float64
	}
	owner.do("GET", p+"/vitals", nil, 200, &vitals)
	if len(vitals) == 0 || vitals[0].Path != "" || vitals[0].LCP != 1800 {
		t.Fatalf("vitals: %+v", vitals)
	}
	var events []struct {
		Name  string
		Count int
		Value float64
	}
	owner.do("GET", p+"/events", nil, 200, &events)
	if len(events) != 1 || events[0].Name != "signup" || events[0].Value != 49 {
		t.Fatalf("events: %+v", events)
	}
	var heat struct {
		Clicks   int
		Cells    []struct{ X, Y, N int }
		Scroll   []int
		Snapshot *struct{ RecordingID string }
	}
	owner.do("GET", p+"/heatmap?path=/&device=Desktop", nil, 200, &heat)
	if heat.Clicks != 1 || heat.Cells[0].X != 50 || heat.Cells[0].Y != 31 || heat.Scroll[7] != 1 || heat.Scroll[8] != 0 || heat.Snapshot == nil || heat.Snapshot.RecordingID != rec.id {
		t.Fatalf("heatmap: %+v", heat)
	}
	owner.do("GET", p+"/heatmap", nil, 400, nil)
	owner.do("GET", p+"/retention", nil, 200, nil)
	owner.do("GET", p+"/releases", nil, 200, nil)
	owner.do("GET", p+"/accounts", nil, 200, nil)
	owner.do("GET", p+"/heatmaps", nil, 200, nil)

	// Every number opens its recordings.
	var list struct{ Total int }
	for query, want := range map[string]int{"event=rage:button.buy": 1, "event=track:signup": 1, "event=error:" + groups[0].Fingerprint: 0,
		"referrer=google.com": 1, "utmCampaign=spring": 1, "channel=Search": 1, "referrer=Direct": 0, "entry=/page-0": 1, "sort=score": 1, "language=en-GB": 1} {
		owner.do("GET", p+"/recordings?"+query, nil, 200, &list)
		if list.Total != want {
			t.Errorf("recordings?%s: %d, want %d", query, list.Total, want)
		}
	}

	// Feedback arrives with the session it was sent from.
	var inbox struct {
		Items []struct {
			ID, Body string
			Recorded bool
		}
		Unseen int
	}
	owner.do("GET", p+"/feedback", nil, 200, &inbox)
	if len(inbox.Items) != 1 || !inbox.Items[0].Recorded || inbox.Unseen != 1 {
		t.Fatalf("feedback: %+v", inbox)
	}
	owner.do("PATCH", p+"/feedback/"+inbox.Items[0].ID, obj{"seen": true}, 204, nil)

	// Notes.
	var note struct{ ID, Author string }
	owner.do("POST", p+"/recordings/"+rec.id+"/notes", obj{"atMs": 4200, "body": " Look here "}, 201, &note)
	owner.do("POST", p+"/recordings/"+rec.id+"/notes", obj{"atMs": 1, "body": " "}, 400, nil)
	var notes []struct{ Body, Author string }
	owner.do("GET", p+"/recordings/"+rec.id+"/notes", nil, 200, &notes)
	if len(notes) != 1 || notes[0].Body != "Look here" || notes[0].Author != "Ada" {
		t.Fatalf("notes: %+v", notes)
	}

	// Public links are off until an admin turns them on.
	owner.do("POST", p+"/shares", obj{"kind": "recording", "recordingId": rec.id, "expiresInDays": 7}, 403, nil)
	owner.do("PATCH", p+"/settings", obj{"sharing": obj{"enabled": true}}, 200, nil)
	owner.do("POST", p+"/shares", obj{"kind": "recording", "recordingId": rec.id, "expiresInDays": 2}, 400, nil)
	var share struct{ ID, Link string }
	owner.do("POST", p+"/shares", obj{"kind": "recording", "recordingId": rec.id, "startMs": 1500, "expiresInDays": 7}, 201, &share)
	token := share.Link[strings.LastIndex(share.Link, "/")+1:]
	stranger := newClient(t, srv.URL)
	var public struct {
		Kind, Project string
		StartMs       int64
		Recording     obj
	}
	stranger.do("GET", "/api/v1/shared/"+token, nil, 200, &public)
	if public.Kind != "recording" || public.Project != "Shop" || public.StartMs != 1500 || public.Recording["visitor"] != nil {
		t.Fatalf("public link: %+v", public)
	}
	// A public link gets an allow-list: the exact keys below and nothing
	// else, and of the events only what plays the page back.
	sameKeys := func(what string, got obj, want ...string) {
		t.Helper()
		keys := make([]string, 0, len(got))
		for k := range got {
			keys = append(keys, k)
		}
		slices.Sort(keys)
		slices.Sort(want)
		if !slices.Equal(keys, want) {
			t.Fatalf("%s has keys %v, want exactly %v", what, keys, want)
		}
	}
	body := func(path string) string {
		t.Helper()
		res, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		raw, _ := io.ReadAll(res.Body)
		if res.StatusCode != 200 {
			t.Fatalf("GET %s: %d", path, res.StatusCode)
		}
		return string(raw)
	}
	var whole obj
	stranger.do("GET", "/api/v1/shared/"+token, nil, 200, &whole)
	sameKeys("a public recording link", whole, "kind", "project", "expiresAt", "startMs", "recording")
	sameKeys("its recording", whole["recording"].(obj), "startedAt", "durationMs", "viewport", "pages", "device", "browser", "os", "live")
	var evs eventsResponse
	stranger.do("GET", "/api/v1/shared/"+token+"/events?after=-1", nil, 200, &evs)
	var signedIn eventsResponse
	owner.do("GET", p+"/recordings/"+rec.id+"/events?after=-1", nil, 200, &signedIn)
	if len(signedIn.Events) != len(rec.all(0)) || len(evs.Events) != len(signedIn.Events)-3 {
		t.Fatalf("public events: %d of %d (the console, identify and network events must be left out)", len(evs.Events), len(signedIn.Events))
	}
	for _, e := range evs.Events {
		ev := e.(obj)
		kind := ev["type"].(float64)
		if kind > 5 || (kind == 5 && ev["data"].(obj)["tag"] != "navigate") {
			t.Fatalf("a public link received %v", ev)
		}
		if kind == 5 {
			sameKeys("a public navigate event", ev["data"].(obj)["payload"].(obj), "href", "path", "title")
		}
	}
	publicEvents := body("/api/v1/shared/" + token + "/events?after=-1")
	for _, forbidden := range []string{"console", "batch 0", "identify", "ada@example.com", "user-42", "network", "api.acme.dev/secret", "anon-1", rec.id, "visitor"} {
		if strings.Contains(publicEvents, forbidden) || strings.Contains(body("/api/v1/shared/"+token), forbidden) {
			t.Errorf("%q reached a public recording link", forbidden)
		}
	}
	if !strings.Contains(publicEvents, `"tag":"navigate"`) || !strings.Contains(publicEvents, "/pricing") {
		t.Error("the navigation a public page shows is missing")
	}
	stranger.do("GET", "/api/v1/shared/"+token+"/analytics", nil, 404, nil)
	stranger.do("GET", "/api/v1/shared/"+strings.Repeat("0", 64), nil, 404, nil)
	stranger.do("GET", p+"/recordings", nil, 401, nil)
	var dash struct{ Link string }
	owner.do("POST", p+"/shares", obj{"kind": "dashboard", "expiresInDays": 1}, 201, &dash)
	dashToken := dash.Link[strings.LastIndex(dash.Link, "/")+1:]
	stranger.do("GET", "/api/v1/shared/"+dashToken+"/analytics?days=7", nil, 200, &traffic)
	if traffic.Totals.Visits != 3 {
		t.Fatalf("shared analytics: %+v", traffic.Totals)
	}
	whole = nil // decoding into a used map would keep its old keys
	stranger.do("GET", "/api/v1/shared/"+dashToken+"/analytics?days=7", nil, 200, &whole)
	sameKeys("public analytics", whole, "totals", "previous", "days", "sources", "channels", "campaigns", "pages", "entryPages", "exitPages",
		"countries", "devices", "browsers", "systems", "languages", "goals", "goalSources")
	sameKeys("public totals", whole["totals"].(obj), "visitors", "visits", "pageviews", "bounces", "avgDurationMs", "newVisitors", "returning")
	sameKeys("a public page row", whole["pages"].([]any)[0].(obj), "path", "views", "visitors", "avgTimeMs", "exits", "scroll")
	sameKeys("a public source row", whole["sources"].([]any)[0].(obj), "name", "visitors", "visits")
	sameKeys("a public goal", whole["goals"].([]any)[0].(obj), "id", "name", "kind", "value", "conversions")
	sameKeys("a public link to analytics", func() obj { var v obj; stranger.do("GET", "/api/v1/shared/"+dashToken, nil, 200, &v); return v }(),
		"kind", "project", "expiresAt", "startMs")
	publicNumbers := body("/api/v1/shared/" + dashToken + "/analytics?days=7")
	for _, forbidden := range []string{rec.id, "visit-2", "anon-", "TypeError", "price is undefined", "The buy button does nothing", "button.buy",
		"fingerprint", "visitId", "recordingId", "email", hook.URL, "s3cret"} {
		if strings.Contains(publicNumbers, forbidden) {
			t.Errorf("%q reached a public analytics link", forbidden)
		}
	}
	// The other project routes stay closed to a link's holder.
	for _, closed := range []string{"/errors", "/friction", "/feedback", "/funnels", "/events", "/recordings", "/visitors", "/heatmaps", "/requests", "/shares", "/settings"} {
		stranger.do("GET", p+closed, nil, 401, nil)
		stranger.do("GET", "/api/v1/shared/"+dashToken+closed, nil, 404, nil)
	}
	stranger.do("GET", "/api/v1/shared/"+dashToken+"/events", nil, 404, nil)
	var shares []struct{ ID string }
	owner.do("GET", p+"/shares", nil, 200, &shares)
	if len(shares) != 2 {
		t.Fatalf("%d links listed", len(shares))
	}
	// Turning sharing off stops every link; a revoked link stays dead.
	owner.do("PATCH", p+"/settings", obj{"sharing": obj{"enabled": false}}, 200, nil)
	stranger.do("GET", "/api/v1/shared/"+token, nil, 404, nil)
	owner.do("PATCH", p+"/settings", obj{"sharing": obj{"enabled": true}}, 200, nil)
	stranger.do("GET", "/api/v1/shared/"+token, nil, 200, nil)
	owner.do("DELETE", p+"/shares/"+share.ID, nil, 204, nil)
	stranger.do("GET", "/api/v1/shared/"+token, nil, 404, nil)
	// A link dies with its recording.
	owner.do("POST", p+"/shares", obj{"kind": "recording", "recordingId": rec.id, "expiresInDays": 1}, 201, &share)
	token = share.Link[strings.LastIndex(share.Link, "/")+1:]
	owner.do("DELETE", p+"/recordings/"+rec.id, nil, 204, nil)
	stranger.do("GET", "/api/v1/shared/"+token, nil, 404, nil)

	// A viewer never sees the webhook.
	var settings struct {
		Alerts struct{ WebhookURL, Secret string }
	}
	owner.do("GET", p+"/settings", nil, 200, &settings)
	if settings.Alerts.WebhookURL != hook.URL || settings.Alerts.Secret != "s3cret" {
		t.Fatalf("admin settings: %+v", settings)
	}

	// The digest on demand.
	owner.do("POST", p+"/alerts/digest", nil, 204, nil)
	digest := receiver.wait(t, "digest.weekly")
	if !strings.Contains(digest["text"].(string), "3 visitors") {
		t.Fatalf("digest: %v", digest["text"])
	}

	// An assistant reads the same numbers over MCP with an API token.
	var tok struct{ Secret string }
	owner.do("POST", "/api/v1/tokens", obj{"name": "mcp", "access": "read", "expiresInDays": nil}, 201, &tok)
	agent := newClient(t, srv.URL)
	agent.do("POST", "/mcp", obj{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": obj{"protocolVersion": "2025-03-26"}}, 401, nil)
	agent.auth = tok.Secret
	var rpc struct {
		Result struct {
			ProtocolVersion string
			Tools           []struct{ Name string }
			IsError         bool
			Content         []struct{ Type, Text string }
		}
		Error *struct{ Code int }
	}
	agent.do("POST", "/mcp", obj{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": obj{"protocolVersion": "2025-03-26"}}, 200, &rpc)
	if rpc.Result.ProtocolVersion != "2025-03-26" {
		t.Fatalf("initialize: %+v", rpc)
	}
	agent.do("POST", "/mcp", obj{"jsonrpc": "2.0", "method": "notifications/initialized"}, 202, nil)
	agent.do("POST", "/mcp", obj{"jsonrpc": "2.0", "id": 2, "method": "tools/list"}, 200, &rpc)
	if len(rpc.Result.Tools) < 8 {
		t.Fatalf("tools: %+v", rpc.Result.Tools)
	}
	agent.do("POST", "/mcp", obj{"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": obj{"name": "get_traffic", "arguments": obj{"project": proj.ID, "days": 7}}}, 200, &rpc)
	if rpc.Result.IsError || len(rpc.Result.Content) != 1 || !strings.Contains(rpc.Result.Content[0].Text, `"visits":3`) {
		t.Fatalf("get_traffic: %+v", rpc.Result)
	}
	agent.do("POST", "/mcp", obj{"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": obj{"name": "list_errors", "arguments": obj{"project": "missing"}}}, 200, &rpc)
	if !rpc.Result.IsError {
		t.Fatal("an unknown project must be a tool error")
	}
	agent.do("POST", "/mcp", obj{"jsonrpc": "2.0", "id": 5, "method": "nope"}, 200, &rpc)
	if rpc.Error == nil || rpc.Error.Code != -32601 {
		t.Fatalf("unknown method: %+v", rpc)
	}

	// Erasing a visitor removes their visits, events and feedback.
	owner.do("POST", p+"/visitors/erase", obj{"query": "nobody"}, 200, nil)
	owner.do("DELETE", "/api/v1/projects/"+proj.ID, nil, 204, nil)
	if at, _ := a.Store.LastVisitAt(ctx, proj.ID); at != 0 {
		t.Error("visits are left after deleting the project")
	}
	if n, _ := a.Store.CountEvents(ctx, proj.ID, "page", 0); n != 0 {
		t.Errorf("%d events are left after deleting the project", n)
	}
	if page, _ := a.Store.ListFeedback(ctx, proj.ID, 0, 10); page.Total != 0 {
		t.Error("feedback is left after deleting the project")
	}
	if links, _ := a.Store.ListShares(ctx, proj.ID, 0); len(links) != 0 {
		t.Error("share links are left after deleting the project")
	}
}
