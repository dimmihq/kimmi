package loadgen

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/klauspost/compress/gzip"

	"github.com/dimmihq/kimmi/internal/envelope"
	"github.com/dimmihq/kimmi/internal/geo"
	"github.com/dimmihq/kimmi/internal/useragent"
)

var testNow = time.Date(2026, 11, 27, 12, 0, 0, 0, time.UTC).UnixMilli()

func testPlan(visits int) seedPlan {
	return seedPlan{Seed: 7, Days: 45, Visits: visits, Recorded: visits / 10, Now: testNow}
}

func generate(p seedPlan) []*Visit {
	g := newGenerator(p)
	var out []*Visit
	for v := g.next(); v != nil; v = g.next() {
		out = append(out, v)
	}
	return out
}

// sample is 20,000 visits, generated once for the tests that measure shares.
var sample = sync.OnceValue(func() []*Visit { return generate(testPlan(20_000)) })

// funnelSteps is the funnel as the dashboard would define it.
var funnelSteps = []func(e Event) bool{
	func(e Event) bool { return e.K == "page" && e.P == "/" },
	func(e Event) bool { return e.K == "page" && strings.HasPrefix(e.P, "/products/") },
	func(e Event) bool { return e.K == "track" && e.N == "add_to_cart" },
	func(e Event) bool { return e.K == "page" && e.P == "/cart" },
	func(e Event) bool { return e.K == "page" && e.P == "/checkout" },
	func(e Event) bool { return e.K == "track" && e.N == "purchase" },
	func(e Event) bool { return e.K == "page" && e.P == "/thanks" },
}

// funnelDepth counts the steps a visit did in order, one event a step.
func funnelDepth(v *Visit) int {
	step := 0
	for _, e := range v.Events {
		if step < len(funnelSteps) && funnelSteps[step](e) {
			step++
		}
	}
	return step
}

func near(t *testing.T, what string, got, want, tolerance float64) {
	t.Helper()
	if math.Abs(got-want) > tolerance {
		t.Errorf("%s = %.3f, want %.3f ± %.3f", what, got, want, tolerance)
	}
}

func TestSeedIsDeterministic(t *testing.T) {
	a, _ := json.Marshal(generate(testPlan(400)))
	b, _ := json.Marshal(generate(testPlan(400)))
	if !bytes.Equal(a, b) {
		t.Fatal("the same plan gave two different histories")
	}
	other := testPlan(400)
	other.Seed = 8
	if c, _ := json.Marshal(generate(other)); bytes.Equal(a, c) {
		t.Fatal("another seed gave the same history")
	}
	v := generate(testPlan(400))[10]
	v.Recorded = true
	pg := buildPage()
	x, _ := json.Marshal(recording(v, &pg))
	y, _ := json.Marshal(recording(v, &pg))
	if !bytes.Equal(x, y) {
		t.Fatal("the same visit gave two different recordings")
	}
}

func TestSeedFunnel(t *testing.T) {
	var reached [8]int
	for _, v := range sample() {
		for s := 1; s <= funnelDepth(v); s++ {
			reached[s]++
		}
	}
	t.Logf("funnel: %v", reached[1:])
	for s := 2; s <= 7; s++ {
		if reached[s] > reached[s-1] {
			t.Errorf("step %d has %d visits, more than the %d of step %d", s, reached[s], reached[s-1], s-1)
		}
	}
	// About 100 → 62 → 21 → 15 → 9 → 6 → 6.
	want := []float64{0, 100, 62, 21, 15, 9, 6, 6}
	tolerance := []float64{0, 0, 4, 3, 2.5, 2, 1.5, 1.5}
	for s := 2; s <= 7; s++ {
		near(t, "funnel step "+string(rune('0'+s)), 100*float64(reached[s])/float64(reached[1]), want[s], tolerance[s])
	}
}

func TestSeedReturningOverSixtyDays(t *testing.T) {
	p := testPlan(20_000)
	p.Days = 60
	returning := 0.0
	for _, v := range generate(p) {
		if v.Returning {
			returning++
		}
	}
	near(t, "returning share over 60 days", returning/20_000, 0.35, 0.03)
}

func TestSeedShares(t *testing.T) {
	visits := sample()
	n := float64(len(visits))
	var bounces, returning, recorded, feedback, direct float64
	var class [3]float64
	visitors, identified := map[string]bool{}, map[string]bool{}
	zones, channels := map[string]bool{}, map[string]float64{}
	for _, v := range visits {
		if v.Bounce {
			bounces++
		}
		if v.Returning {
			returning++
		}
		if v.Recorded {
			recorded++
		}
		if v.Feedback != nil {
			feedback++
		}
		if v.Channel == "Direct" {
			direct++
		}
		channels[v.Channel]++
		class[v.Visitor.Agent.class]++
		visitors[v.Visitor.AnonymousID] = true
		if v.Visitor.Identity != nil {
			identified[v.Visitor.AnonymousID] = true
		}
		zones[v.Visitor.Zone.name] = true
		width := v.Visitor.W
		switch v.Visitor.Agent.class {
		case classDesktop:
			if width < 1280 || width > 1920 {
				t.Fatalf("desktop viewport %d wide", width)
			}
		case classTablet:
			if width < 768 || width > 1024 {
				t.Fatalf("tablet viewport %d wide", width)
			}
		default:
			if width < 360 || width > 430 {
				t.Fatalf("mobile viewport %d wide", width)
			}
		}
	}
	t.Logf("bounce %.3f, returning %.3f, desktop %.3f, mobile %.3f, tablet %.3f, identified %.3f of %d visitors",
		bounces/n, returning/n, class[classDesktop]/n, class[classMobile]/n, class[classTablet]/n,
		float64(len(identified))/float64(len(visitors)), len(visitors))
	near(t, "bounce share", bounces/n, 0.28, 0.03)
	near(t, "returning share", returning/n, 0.35, 0.03)
	near(t, "desktop share", class[classDesktop]/n, 0.58, 0.02)
	near(t, "mobile share", class[classMobile]/n, 0.36, 0.02)
	near(t, "tablet share", class[classTablet]/n, 0.06, 0.012)
	near(t, "direct share", direct/n, 0.30, 0.04)
	near(t, "identified visitors", float64(len(identified))/float64(len(visitors)), 0.08, 0.015)
	near(t, "feedback share", feedback/n, 0.003, 0.002)
	if recorded != float64(testPlan(len(visits)).Recorded) {
		t.Errorf("%d visits recorded, want %d", int(recorded), testPlan(len(visits)).Recorded)
	}
	if len(zones) < 25 {
		t.Errorf("%d time zones, want at least 25", len(zones))
	}
	for _, c := range []string{"Direct", "Search", "Social", "AI", "Referral", "Email", "Paid"} {
		if channels[c] == 0 {
			t.Errorf("no visit from channel %s", c)
		}
	}
}

func TestSeedRecordsWhatIsWorthWatching(t *testing.T) {
	var all, trouble, allRecorded, troubleRecorded float64
	var dropped, droppedRecorded [6]float64
	for _, v := range sample() {
		all++
		rec := 0.0
		if v.Recorded {
			rec = 1
		}
		allRecorded += rec
		if v.Errors > 0 || v.Rages > 0 {
			trouble++
			troubleRecorded += rec
		}
		dropped[v.Reached]++
		droppedRecorded[v.Reached] += rec
	}
	if base, got := allRecorded/all, troubleRecorded/trouble; got < 2*base {
		t.Errorf("%.2f of visits with errors or rage clicks are recorded, against %.2f of all", got, base)
	}
	for step := range dropped {
		if droppedRecorded[step] < 10 {
			t.Errorf("only %.0f recordings of the %.0f visits that stopped at step %d", droppedRecorded[step], dropped[step], step)
		}
	}
}

func TestSeedHasEveryKindOfEvent(t *testing.T) {
	seen := map[string]int{}
	errors := map[string]bool{}
	releases := map[string]bool{}
	for _, v := range sample() {
		releases[v.Release] = true
		for _, e := range v.Events {
			seen[e.K]++
			switch e.K {
			case "track", "vital", "request":
				seen[e.K+":"+e.N]++
			case "error":
				errors[strings.Map(func(r rune) rune {
					if r >= '0' && r <= '9' {
						return -1
					}
					return r
				}, e.L)] = true
				var d struct{ Source, Stack string }
				if err := json.Unmarshal(e.D, &d); err != nil || d.Source == "" || !strings.Contains(d.Stack, "\n    at ") {
					t.Fatalf("error without source and stack: %s", e.D)
				}
				if strings.Contains(e.L, "Invalid quantity") && float64(testNow-e.T)/dayMs > 5.1 {
					t.Fatalf("the new error happened %.1f days ago", float64(testNow-e.T)/dayMs)
				}
				if strings.Contains(e.L, "takeRecords") && !v.Visitor.Agent.safari {
					t.Fatal("the Safari error happened in another browser")
				}
				if strings.Contains(e.L, "tokenize") && e.P != "/checkout" {
					t.Fatalf("the checkout error happened on %s", e.P)
				}
			case "leave":
				if e.Num < 1 || e.Num > 100 || e.Y == 0 || e.W != v.Visitor.W || e.V <= 0 {
					t.Fatalf("leave is off: %+v", e)
				}
			case "click":
				if e.X < 0 || e.X > 10000 || e.W != v.Visitor.W || e.N == "" {
					t.Fatalf("click is off: %+v", e)
				}
			}
		}
	}
	for _, k := range []string{"page", "leave", "track", "error", "rage", "dead", "click", "request", "vital",
		"track:add_to_cart", "track:purchase", "track:$form", "track:$outbound", "track:$download", "track:$email",
		"vital:lcp", "vital:fcp", "vital:ttfb", "vital:cls", "vital:inp",
		"request:POST shop.example/api/orders", "request:GET shop.example/api/stock/linen-throw.json"} {
		if seen[k] == 0 {
			t.Errorf("no %s event in 20,000 visits", k)
		}
	}
	if len(errors) < 6 || len(errors) > 8 {
		t.Errorf("%d kinds of error, want 6 to 8", len(errors))
	}
	if len(releases) != len(seedReleases) {
		t.Errorf("%d releases, want %d", len(releases), len(seedReleases))
	}
	t.Logf("events: %v", seen)
}

func TestSeedTimes(t *testing.T) {
	p := testPlan(0)
	from := p.Now - int64(p.Days)*dayMs
	lastDay, lastMinutes := 0, 0
	perDay := make([]int, p.Days)
	for _, v := range sample() {
		if v.Start < from || v.End > p.Now || v.End < v.Start {
			t.Fatalf("visit %d runs %d to %d, outside %d to %d", v.Index, v.Start, v.End, from, p.Now)
		}
		at := v.Start
		for _, e := range v.Events {
			if e.T < at || e.T > v.End {
				t.Fatalf("visit %d: event at %d after one at %d (visit ends %d)", v.Index, e.T, at, v.End)
			}
			at = e.T
		}
		if f := v.Feedback; f != nil && (f.At < v.Start || f.At > v.End) {
			t.Fatalf("visit %d: feedback outside the visit", v.Index)
		}
		if v.Start > p.Now-dayMs {
			lastDay++
		}
		if v.End > p.Now-120_000 {
			lastMinutes++
		}
		perDay[(v.Start-from)/dayMs]++
	}
	if lastDay < 100 {
		t.Errorf("%d visits in the last 24 hours", lastDay)
	}
	if lastMinutes < 4 {
		t.Errorf("%d visits in the last two minutes, want a handful", lastMinutes)
	}
	week := func(days []int) (sum float64) {
		for _, n := range days {
			sum += float64(n)
		}
		return sum
	}
	if growth := week(perDay[p.Days-7:]) / week(perDay[:7]); growth < 1.5 || growth > 3 {
		t.Errorf("the last week has %.2f times the visits of the first, want about 2", growth)
	}
}

func TestSeedHitsFitTheServer(t *testing.T) {
	for _, v := range sample() {
		events := 0
		for _, h := range v.hits() {
			body, err := json.Marshal(h)
			if err != nil {
				t.Fatal(err)
			}
			if len(h.Events) == 0 || len(h.Events) > 100 || len(body) > 60<<10 {
				t.Fatalf("visit %d: a hit of %d events and %d bytes", v.Index, len(h.Events), len(body))
			}
			if last := h.Events[len(h.Events)-1].T; h.At != last || h.StartedAt != v.Start || h.VisitID != v.ID {
				t.Fatalf("visit %d: hit at %d, last event %d", v.Index, h.At, last)
			}
			events += len(h.Events)
		}
		if events != len(v.Events) {
			t.Fatalf("visit %d: %d of %d events in its hits", v.Index, events, len(v.Events))
		}
	}
}

func TestSeedTablesMatchTheServer(t *testing.T) {
	if len(seedZones) < 25 {
		t.Errorf("%d time zones, want at least 25", len(seedZones))
	}
	for _, z := range seedZones {
		if geo.FromTimezone(z.name).CountryCode == "" {
			t.Errorf("time zone %s is not in internal/geo", z.name)
		}
	}
	want := [3]string{classDesktop: useragent.Desktop, classTablet: useragent.Tablet, classMobile: useragent.Mobile}
	for _, a := range seedAgents {
		got := useragent.Parse(a.ua)
		if got.Device != want[a.class] || got.Browser == "Other" || got.OS == "Other" || (got.Browser == "Safari") != a.safari {
			t.Errorf("%q reads as %+v", a.ua, got)
		}
	}
	if len(companyDomains) < 40 || len(feedbackTexts) < 15 || len(seedProducts) < 8 {
		t.Error("the tables are shorter than promised")
	}
}

func TestSeedRecordingMatchesTheVisit(t *testing.T) {
	pg := buildPage()
	checked := 0
	for _, v := range sample() {
		if !v.Recorded || checked >= 300 {
			continue
		}
		checked++
		var want, got envelope.Counts
		for _, e := range v.Events {
			switch e.K {
			case "page":
				want.Pageviews++
			case "click":
				want.Clicks++
			case "rage":
				want.RageClicks++
			case "dead":
				want.DeadClicks++
			case "error":
				want.Errors++
			case "leave":
				want.ActiveMs += int64(e.V)
			}
		}
		batches := recording(v, &pg)
		if len(batches) < 2 || len(batches) > 6 {
			t.Fatalf("visit %d: %d batches", v.Index, len(batches))
		}
		last, size := v.Start, 0
		for i, b := range batches {
			m := b.Meta
			if m.Seq != int64(i) || m.SessionID != v.ID || m.AnonymousID != v.Visitor.AnonymousID || m.StartedAt != v.Start ||
				m.FirstTs < last || m.LastTs < m.FirstTs || m.LastTs > v.End+1000 || m.Release != v.Release {
				t.Fatalf("visit %d batch %d: metadata is off: %+v", v.Index, i, m)
			}
			last = m.LastTs
			var events []struct {
				Type      int   `json:"type"`
				Timestamp int64 `json:"timestamp"`
			}
			if err := json.Unmarshal(b.Events, &events); err != nil || len(events) != m.Counts.Events {
				t.Fatalf("visit %d batch %d: %d events, counted %d: %v", v.Index, i, len(events), m.Counts.Events, err)
			}
			for _, e := range events {
				if e.Timestamp < m.FirstTs || e.Timestamp > m.LastTs {
					t.Fatalf("visit %d batch %d: event at %d outside %d to %d", v.Index, i, e.Timestamp, m.FirstTs, m.LastTs)
				}
			}
			var gz bytes.Buffer
			zw := gzip.NewWriter(&gz)
			zw.Write(b.Events)
			zw.Close()
			size += gz.Len()
			got.Pageviews += m.Counts.Pageviews
			got.Clicks += m.Counts.Clicks
			got.RageClicks += m.Counts.RageClicks
			got.DeadClicks += m.Counts.DeadClicks
			got.Errors += m.Counts.Errors
			got.ActiveMs += m.Counts.ActiveMs
		}
		if got != want {
			t.Fatalf("visit %d: recording counts %+v, hits say %+v", v.Index, got, want)
		}
		if size > 16<<10 {
			t.Fatalf("visit %d: a recording of %d bytes", v.Index, size)
		}
		if id := v.Visitor.Identity; (id == nil) != (batches[0].Meta.Identity == nil) {
			t.Fatalf("visit %d: identity is off", v.Index)
		}
	}
	if checked == 0 {
		t.Fatal("no recorded visit")
	}
}

// fakeServer records what the command posts.
type fakeServer struct {
	mu        sync.Mutex
	hits      []seedHit
	batches   []envelope.Meta
	feedback  []map[string]any
	agents    map[string]bool
	bad       []string
	analytics bool
	busy      int // answer this many posts with 503 first
}

func (f *fakeServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	f.mu.Lock()
	defer f.mu.Unlock()
	if r.URL.Query().Get("key") != "km_pub_test" {
		w.WriteHeader(http.StatusForbidden)
		return
	}
	if r.URL.Path == "/i/v1/config" {
		io.WriteString(w, `{"recording":true}`)
		return
	}
	if f.busy > 0 {
		f.busy--
		w.Header().Set("Retry-After", "0")
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	f.agents[r.UserAgent()] = true
	switch r.URL.Path {
	case "/i/v1/hit":
		if !f.analytics {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		var h seedHit
		if err := json.Unmarshal(body, &h); err != nil || h.V != 1 || h.At == 0 || len(h.Events) == 0 || len(body) > 64<<10 {
			f.bad = append(f.bad, "hit: "+string(body[:min(len(body), 200)]))
		}
		f.hits = append(f.hits, h)
	case "/i/v1/batch":
		meta, _, err := envelope.Parse(body)
		if err != nil {
			f.bad = append(f.bad, "batch: "+err.Error())
		}
		f.batches = append(f.batches, meta)
	case "/i/v1/feedback":
		var fb map[string]any
		if err := json.Unmarshal(body, &fb); err != nil || fb["text"] == "" || fb["at"] == nil || fb["visitId"] == "" {
			f.bad = append(f.bad, "feedback: "+string(body))
		}
		f.feedback = append(f.feedback, fb)
	default:
		f.bad = append(f.bad, "unknown route "+r.URL.Path)
	}
	w.WriteHeader(http.StatusNoContent)
}

func TestSeedCommand(t *testing.T) {
	fake := &fakeServer{agents: map[string]bool{}, analytics: true, busy: 3}
	srv := httptest.NewServer(fake)
	defer srv.Close()
	var out bytes.Buffer
	o := SeedOptions{Host: srv.URL, Key: "km_pub_test", Days: 30, Visits: 3000, Recorded: 300, Concurrency: 16, Seed: 3, Analytics: true}
	began := time.Now().UnixMilli()
	rep, err := Seed(context.Background(), o, &out)
	if err != nil {
		t.Fatal(err)
	}
	ended := time.Now().UnixMilli()
	if len(fake.bad) > 0 {
		t.Fatalf("%d bad requests, first: %s", len(fake.bad), fake.bad[0])
	}
	if rep.Failed != 0 || rep.Retries != 3 || rep.Visits != 3000 || rep.Recordings != 300 {
		t.Fatalf("report: %+v", rep)
	}
	visits, sessions := map[string]bool{}, map[string]int{}
	events, pages, recent := 0, 0, 0
	for _, h := range fake.hits {
		visits[h.VisitID] = true
		events += len(h.Events)
		if h.At < began-30*dayMs-1000 || h.At > ended {
			t.Fatalf("a hit at %d, outside the 30 days before %d", h.At, ended)
		}
		if h.At > ended-120_000 {
			recent++
		}
		for _, e := range h.Events {
			if e.K == "page" {
				pages++
			}
			if e.T > h.At || e.T < h.At-dayMs {
				t.Fatalf("an event at %d in a hit at %d", e.T, h.At)
			}
		}
	}
	for _, m := range fake.batches {
		sessions[m.SessionID]++
		if !visits[m.SessionID] {
			t.Fatalf("recording %s has no visit", m.SessionID)
		}
	}
	if len(visits) != 3000 || len(sessions) != 300 || int64(len(fake.hits)) != rep.Hits || int64(len(fake.batches)) != rep.Batches ||
		int64(events) != rep.Events || int64(pages) != rep.PageViews || int64(len(fake.feedback)) != rep.Feedback {
		t.Fatalf("server saw %d visits, %d recordings, %d hits, %d batches, %d events, %d feedback; report: %+v",
			len(visits), len(sessions), len(fake.hits), len(fake.batches), events, len(fake.feedback), rep)
	}
	for id, n := range sessions {
		if n < 2 || n > 6 {
			t.Fatalf("recording %s has %d batches", id, n)
		}
	}
	if recent < 3 {
		t.Errorf("%d hits in the last two minutes", recent)
	}
	if len(fake.agents) < 10 {
		t.Errorf("%d user agents", len(fake.agents))
	}
	if !strings.Contains(rep.String(), "visits      3000") {
		t.Errorf("summary:\n%s", rep)
	}
}

func TestSeedStopsWhenAnalyticsIsOff(t *testing.T) {
	fake := &fakeServer{agents: map[string]bool{}}
	srv := httptest.NewServer(fake)
	defer srv.Close()
	o := SeedOptions{Host: srv.URL, Key: "km_pub_test", Days: 14, Visits: 400, Recorded: 60, Concurrency: 8, Seed: 3, Analytics: true}
	if _, err := Seed(context.Background(), o, io.Discard); err != errAnalyticsOff {
		t.Fatalf("err = %v, want the analytics-off message", err)
	}
	if len(fake.hits)+len(fake.batches) != 0 {
		t.Fatalf("sent %d hits and %d batches to a project without analytics", len(fake.hits), len(fake.batches))
	}

	// A replay-only project gets the recordings and no hit.
	o.Analytics = false
	rep, err := Seed(context.Background(), o, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	sessions := map[string]bool{}
	for _, m := range fake.batches {
		sessions[m.SessionID] = true
	}
	if len(fake.hits) != 0 || len(fake.feedback) != 0 || len(sessions) != 60 || rep.Recordings != 60 || rep.Failed != 0 || len(fake.bad) > 0 {
		t.Fatalf("replay only: %d hits, %d recordings, report %+v, bad %v", len(fake.hits), len(sessions), rep, fake.bad)
	}

	o.Key = "km_pub_wrong"
	if _, err := Seed(context.Background(), o, io.Discard); err == nil {
		t.Fatal("an unknown key was accepted")
	}
}
