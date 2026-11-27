package storetest

import (
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/dimmihq/kimmi/internal/store"
)

// base is a Monday at midnight UTC, so day and week buckets are known.
var base = time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC).UnixMilli()

const (
	hour   = int64(3_600_000)
	minute = int64(60_000)
)

// hit builds one analytics post of an anonymous-id visitor. Events without
// a time happen at at.
func hit(p store.Project, visit, visitor string, at int64, events ...store.Event) store.Hit {
	for i := range events {
		if events[i].Ts == 0 {
			events[i].Ts = at
		}
	}
	return store.Hit{OrgID: p.OrgID, ProjectID: p.ID, VisitID: visit, VisitorKey: "a:" + visitor, StartedAt: at, At: at,
		Channel: "Direct", CountryCode: "NG", Device: "Desktop", Browser: "Chrome", OS: "macOS", Language: "en", ViewportW: 1440, Events: events}
}

func pageEv(ts int64, path string) store.Event {
	return store.Event{Ts: ts, Kind: store.KindPage, Path: path, Label: "Title of " + path}
}

func ev(kind string, ts int64, path, name string) store.Event {
	return store.Event{Ts: ts, Kind: kind, Path: path, Name: name}
}

func leaveEv(ts int64, path string, ms float64, scroll int) store.Event {
	return store.Event{Ts: ts, Kind: store.KindLeave, Path: path, Value: ms, Num: scroll}
}

func window(p store.Project, from, to int64) store.AnalyticsQuery {
	return store.AnalyticsQuery{ProjectID: p.ID, From: from, To: to, PrevFrom: from - (to - from)}
}

func apply(t *testing.T, s store.Store, hits ...store.Hit) {
	t.Helper()
	// One call per hit, as hits of different flushes arrive.
	for _, h := range hits {
		must(t, s.ApplyHits(ctx, []store.Hit{h}))
	}
}

func breakdown(t *testing.T, rows []store.Breakdown, name string) store.Breakdown {
	t.Helper()
	for _, r := range rows {
		if r.Name == name {
			return r
		}
	}
	t.Fatalf("no breakdown row %q in %v", name, rows)
	return store.Breakdown{}
}

func traffic(t *testing.T, s store.Store, q store.AnalyticsQuery) store.Traffic {
	t.Helper()
	tr, err := s.Traffic(ctx, q)
	must(t, err)
	return tr
}

func testHits(t *testing.T, s store.Store) {
	org, _ := seedOrg(t, s)
	p := seedProject(t, s, org.ID, "shop")
	q := window(p, base, base+day)
	t0 := base + hour
	must(t, s.ApplyHits(ctx, nil))
	at, err := s.LastVisitAt(ctx, p.ID)
	must(t, err)
	eq(t, "no visit yet", at, 0)

	apply(t, s, hit(p, "v1", "A", t0, pageEv(0, "/")))
	tr := traffic(t, s, q)
	eq(t, "visits", tr.Totals.Visits, 1)
	eq(t, "one page is a bounce", tr.Totals.Bounces, 1)

	more := hit(p, "v1", "A", t0+2*minute, pageEv(t0+minute, "/pricing"),
		store.Event{Kind: store.KindClick, Path: "/pricing", Name: "#buy", X: 5000, Y: 100, W: 1440}, leaveEv(0, "/pricing", 5000, 80))
	more.StartedAt = t0
	apply(t, s, more)
	tr = traffic(t, s, q)
	eq(t, "extended visits", tr.Totals.Visits, 1)
	eq(t, "extended visitors", tr.Totals.Visitors, 1)
	eq(t, "extended pageviews", tr.Totals.Pageviews, 2)
	eq(t, "no longer a bounce", tr.Totals.Bounces, 0)
	eq(t, "duration", tr.Totals.AvgDurationMs, 2*minute)
	eq(t, "new visitors", tr.Totals.NewVisitors, 1)
	eq(t, "returning", tr.Totals.Returning, 0)
	eq(t, "entry", tr.EntryPages[0].Name, "/")
	eq(t, "exit", tr.ExitPages[0].Name, "/pricing")
	eq(t, "page time", tr.Pages[1].AvgTimeMs, 5000)

	apply(t, s, hit(p, "v2", "A", t0+3*hour, pageEv(0, "/")))
	tr = traffic(t, s, q)
	eq(t, "second visit", tr.Totals.Visits, 2)
	eq(t, "still one visitor", tr.Totals.Visitors, 1)
	eq(t, "returning visitor", tr.Totals.Returning, 1)
	eq(t, "was new once", tr.Totals.NewVisitors, 1)

	// A cookieless visitor names a new visit on every page load; hits less
	// than 30 minutes apart are one visit.
	cookieless := func(visit, key string, at int64) store.Hit {
		h := hit(p, visit, "", at, pageEv(0, "/"))
		h.VisitorKey, h.Cookieless = "h:"+key, true
		return h
	}
	t1 := t0 + 5*hour
	apply(t, s, cookieless("c1", "zz", t1), cookieless("c2", "zz", t1+5*minute))
	tr = traffic(t, s, q)
	eq(t, "stitched visits", tr.Totals.Visits, 3)
	eq(t, "stitched pageviews", tr.Totals.Pageviews, 5)
	eq(t, "stitched visitors", tr.Totals.Visitors, 2)
	apply(t, s, cookieless("c3", "zz", t1+45*minute))
	eq(t, "40 minutes later is a new visit", traffic(t, s, q).Totals.Visits, 4)
	must(t, s.ApplyHits(ctx, []store.Hit{cookieless("c4", "yy", t1), cookieless("c5", "yy", t1+5*minute)}))
	eq(t, "stitched within one flush", traffic(t, s, q).Totals.Visits, 5)

	at, _ = s.LastVisitAt(ctx, p.ID)
	eq(t, "last visit", at, t1+45*minute)
	n, err := s.CountEvents(ctx, p.ID, store.KindPage, t1)
	must(t, err)
	eq(t, "page events since", n, 5)
	seen, err := s.EventSeenBefore(ctx, p.ID, store.KindClick, "#buy", t0+hour)
	must(t, err)
	eq(t, "event seen before", seen, true)
	seen, _ = s.EventSeenBefore(ctx, p.ID, store.KindClick, "#buy", t0)
	eq(t, "event not seen that early", seen, false)
}

// seedTraffic stores three visits in the two days from base and one in the
// day before. It returns the window of the two days.
//
//	v1 (day 0, a1, google): / -> /pricing -> signup -> /thanks
//	v2 (day 0, a2, direct, mobile, GB): /
//	v3 (day 1, a1 again, google): /pricing -> signup -> /
func seedTraffic(t *testing.T, s store.Store, p store.Project) store.AnalyticsQuery {
	t.Helper()
	google := func(h store.Hit) store.Hit {
		h.Referrer, h.Channel, h.UTMSource, h.UTMCampaign = "google.com", "Search", "google", "spring"
		return h
	}
	t0 := base + 10*hour
	before := hit(p, "v0", "a3", t0-day, pageEv(0, "/"))
	v1 := google(hit(p, "v1", "a1", t0, pageEv(t0, "/"), leaveEv(t0+4000, "/", 4000, 50), pageEv(t0+5000, "/pricing"),
		leaveEv(t0+9000, "/pricing", 6000, 80), leaveEv(t0+15000, "/pricing", 2000, 100),
		store.Event{Ts: t0 + 20000, Kind: store.KindTrack, Path: "/pricing", Name: "signup", Value: 10}))
	v1b := google(hit(p, "v1", "a1", t0+minute, pageEv(t0+21000, "/thanks")))
	v2 := hit(p, "v2", "a2", t0+hour, pageEv(0, "/"))
	v2.CountryCode, v2.Device, v2.Browser, v2.OS, v2.Language = "GB", "Mobile", "Safari", "iOS", "fr"
	t1 := t0 + day
	v3 := google(hit(p, "v3", "a1", t1, pageEv(t1, "/pricing"), leaveEv(t1+1000, "/pricing", 1000, 40),
		store.Event{Ts: t1 + 2000, Kind: store.KindTrack, Path: "/pricing", Name: "signup", Value: 5}))
	v3b := google(hit(p, "v3", "a1", t1+30_000, pageEv(t1+3000, "/")))
	apply(t, s, before, v1, v1b, v2, v3, v3b)
	return window(p, base, base+2*day)
}

func testTraffic(t *testing.T, s store.Store) {
	org, _ := seedOrg(t, s)
	p := seedProject(t, s, org.ID, "shop")
	other := seedProject(t, s, org.ID, "other")
	apply(t, s, hit(other, "o1", "a1", base+hour, pageEv(0, "/")))
	q := seedTraffic(t, s, p)

	tr := traffic(t, s, q)
	eq(t, "totals", tr.Totals, store.TrafficTotals{Visitors: 2, Visits: 3, Pageviews: 6, Bounces: 1, AvgDurationMs: 30_000, NewVisitors: 2, Returning: 1})
	eq(t, "previous", tr.Previous, store.TrafficTotals{Visitors: 1, Visits: 1, Pageviews: 1, Bounces: 1, NewVisitors: 1})
	eq(t, "days", fmt.Sprint(tr.Days), fmt.Sprint([]store.TrafficDay{
		{Date: "2026-06-01", Visitors: 2, Visits: 2, Pageviews: 4}, {Date: "2026-06-02", Visitors: 1, Visits: 1, Pageviews: 2}}))

	eq(t, "sources", fmt.Sprint(tr.Sources), fmt.Sprint([]store.Breakdown{{Name: "google.com", Visitors: 1, Visits: 2}, {Name: "Direct", Visitors: 1, Visits: 1}}))
	eq(t, "channels", fmt.Sprint(tr.Channels), fmt.Sprint([]store.Breakdown{{Name: "Search", Visitors: 1, Visits: 2}, {Name: "Direct", Visitors: 1, Visits: 1}}))
	eq(t, "campaigns", fmt.Sprint(tr.Campaigns), fmt.Sprint([]store.Breakdown{{Name: "spring", Visitors: 1, Visits: 2}, {Name: "None", Visitors: 1, Visits: 1}}))
	eq(t, "entry pages", fmt.Sprint(tr.EntryPages), fmt.Sprint([]store.Breakdown{{Name: "/", Visitors: 2, Visits: 2}, {Name: "/pricing", Visitors: 1, Visits: 1}}))
	eq(t, "exit pages", fmt.Sprint(tr.ExitPages), fmt.Sprint([]store.Breakdown{{Name: "/", Visitors: 2, Visits: 2}, {Name: "/thanks", Visitors: 1, Visits: 1}}))
	eq(t, "countries", breakdown(t, tr.Countries, "GB"), store.Breakdown{Name: "GB", Visitors: 1, Visits: 1})
	eq(t, "devices", breakdown(t, tr.Devices, "Desktop"), store.Breakdown{Name: "Desktop", Visitors: 1, Visits: 2})
	eq(t, "browsers", breakdown(t, tr.Browsers, "Safari").Visits, 1)
	eq(t, "systems", breakdown(t, tr.Systems, "iOS").Visits, 1)
	eq(t, "languages", breakdown(t, tr.Languages, "en").Visits, 2)
	eq(t, "pages", fmt.Sprint(tr.Pages), fmt.Sprint([]store.PageMetric{
		{Path: "/", Views: 3, Visitors: 2, AvgTimeMs: 1333, Exits: 2, Scroll: 50},
		{Path: "/pricing", Views: 2, Visitors: 1, AvgTimeMs: 4500, Exits: 0, Scroll: 73},
		{Path: "/thanks", Views: 1, Visitors: 1, Exits: 1},
	}))

	// A visit is counted on the day of its project's time zone, fixed when
	// it arrives: 10:00 UTC in a zone 14 hours ahead is already tomorrow.
	ahead := seedProject(t, s, org.ID, "ahead")
	late := hit(ahead, "z1", "Z", base+10*hour, pageEv(0, "/"))
	late.DayOffsetMs = 14 * hour
	apply(t, s, late)
	shifted := traffic(t, s, store.AnalyticsQuery{ProjectID: ahead.ID, From: base - 14*hour, To: base + 2*day - 14*hour, PrevFrom: base - 2*day, DayOffsetMs: 14 * hour})
	eq(t, "shifted days", len(shifted.Days), 2)
	eq(t, "shifted first day", shifted.Days[0].Visits, 0)
	eq(t, "shifted second day", shifted.Days[1].Visits, 1)

	filters := []struct {
		f      store.VisitFilter
		visits int
	}{
		{store.VisitFilter{Country: "GB"}, 1},
		{store.VisitFilter{Path: "/thanks"}, 1},
		{store.VisitFilter{Path: "/pricing"}, 2},
		{store.VisitFilter{Entry: "/"}, 2},
		{store.VisitFilter{Exit: "/thanks"}, 1},
		{store.VisitFilter{Referrer: "Direct"}, 1},
		{store.VisitFilter{Referrer: "google.com"}, 2},
		{store.VisitFilter{Channel: "Search", UTMSource: "google", UTMCampaign: "spring"}, 2},
		{store.VisitFilter{Device: "Mobile", Browser: "Safari", OS: "iOS", Language: "fr"}, 1},
		{store.VisitFilter{Device: "Mobile", Referrer: "google.com"}, 0},
	}
	for i, c := range filters {
		fq := q
		fq.Filter = c.f
		eq(t, fmt.Sprintf("filter %d visits", i), traffic(t, s, fq).Totals.Visits, c.visits)
	}
	fq := q
	fq.Filter = store.VisitFilter{Country: "GB"}
	gb := traffic(t, s, fq)
	eq(t, "filtered pages", fmt.Sprint(gb.Pages), fmt.Sprint([]store.PageMetric{{Path: "/", Views: 1, Visitors: 1, Exits: 1}}))
	eq(t, "filtered sources", fmt.Sprint(gb.Sources), fmt.Sprint([]store.Breakdown{{Name: "Direct", Visitors: 1, Visits: 1}}))
	eq(t, "filtered previous", gb.Previous.Visits, 0)
	eq(t, "filtered days", gb.Days[1].Visits, 0)

	empty := traffic(t, s, window(p, base+30*day, base+31*day))
	eq(t, "empty totals", empty.Totals, store.TrafficTotals{})
	eq(t, "empty day", len(empty.Days), 1)
	if empty.Sources == nil || empty.Pages == nil || empty.Languages == nil {
		t.Fatal("empty lists must not be nil")
	}
}

func testGoals(t *testing.T, s store.Store) {
	org, _ := seedOrg(t, s)
	p := seedProject(t, s, org.ID, "shop")
	q := seedTraffic(t, s, p)
	page := func(v string) store.Step { return store.Step{Kind: "page", Value: v} }
	event := func(v string) store.Step { return store.Step{Kind: "event", Value: v} }

	got, err := s.Goals(ctx, q, []store.Step{page("/thanks"), page("/pri*"), event("signup"), event("nope"), page("/PRI*"), page("*"), {Kind: "odd"}})
	must(t, err)
	eq(t, "goals", fmt.Sprint(got), "[1 2 2 0 0 3 0]")
	got, err = s.Goals(ctx, q, nil)
	must(t, err)
	eq(t, "no goals", len(got), 0)
	fq := q
	fq.Filter = store.VisitFilter{Exit: "/"}
	got, _ = s.Goals(ctx, fq, []store.Step{event("signup")})
	eq(t, "filtered goal", got[0], 1)

	src, err := s.GoalSources(ctx, q, page("/"))
	must(t, err)
	eq(t, "goal sources", fmt.Sprint(src), fmt.Sprint([]store.NameCount{{Name: "google.com", Count: 2}, {Name: "Direct", Count: 1}}))
	src, _ = s.GoalSources(ctx, q, event("nope"))
	if src == nil || len(src) != 0 {
		t.Fatalf("sources of an unreached goal: %v", src)
	}

	names, err := s.EventNames(ctx, q)
	must(t, err)
	eq(t, "event names", fmt.Sprint(names), fmt.Sprint([]store.EventStat{{Name: "signup", Count: 2, Visits: 2, Value: 15}}))

	funnel := func(q store.AnalyticsQuery, steps ...store.Step) string {
		t.Helper()
		got, err := s.Funnel(ctx, q, steps)
		must(t, err)
		var b strings.Builder
		for _, st := range got {
			if st.Dropped == nil {
				t.Fatal("dropped must not be nil")
			}
			fmt.Fprintf(&b, "%d%v ", st.Visits, st.Dropped)
		}
		return strings.TrimSpace(b.String())
	}
	// v3 saw /pricing and signed up before it saw /, so it stops at step one.
	eq(t, "funnel", funnel(q, page("/"), page("/pricing"), event("signup")), "3[v3 v2] 1[] 1[]")
	eq(t, "funnel order", funnel(q, event("signup"), page("/")), "2[v1] 1[]")
	eq(t, "funnel prefix", funnel(q, page("/pri*"), page("/thanks")), "2[v3] 1[]")
	eq(t, "funnel same step twice", funnel(q, page("/"), page("/")), "3[v3 v2 v1] 0[]")
	eq(t, "funnel nobody", funnel(q, event("nope"), page("/")), "0[] 0[]")
	eq(t, "funnel filtered", funnel(fq, page("/pricing"), event("signup")), "1[] 1[]")
	eq(t, "funnel without steps", funnel(q), "")
}

func testErrors(t *testing.T, s store.Store) {
	org, _ := seedOrg(t, s)
	p := seedProject(t, s, org.ID, "shop")
	t0 := base + 10*hour
	sid := store.NewID()
	must(t, s.ApplyFlush(ctx, []store.IngestBlock{batch(p, sid, "anon-r", 0, t0)}, t0))

	old := hit(p, "n0", "c", t0-5*day, store.Event{Kind: store.KindError, Path: "/old", Name: "fp1", Label: "first message"})
	rec := hit(p, sid, "anon-r", t0, pageEv(t0, "/checkout"),
		store.Event{Ts: t0 + 1000, Kind: store.KindError, Path: "/checkout", Name: "fp1", Label: "old message", Props: `{"source":"app.js:1"}`},
		store.Event{Ts: t0 + 2000, Kind: store.KindRage, Path: "/checkout", Name: "#pay", Label: "Pay", Value: 4},
		store.Event{Ts: t0 + 3000, Kind: store.KindRequest, Name: "POST api/cart", Value: 300, Num: 500},
		store.Event{Ts: t0 + 3100, Kind: store.KindVital, Path: "/checkout", Name: "lcp", Value: 1000},
		store.Event{Ts: t0 + 3200, Kind: store.KindVital, Path: "/checkout", Name: "lcp", Value: 4000},
		store.Event{Ts: t0 + 3300, Kind: store.KindVital, Path: "/checkout", Name: "cls", Value: 0.1})
	rec.Release = "v2"
	n1 := hit(p, "n1", "b", t0+10_000, pageEv(t0+4000, "/checkout"),
		store.Event{Ts: t0 + 5000, Kind: store.KindError, Path: "/checkout", Name: "fp1", Label: "new message", Props: `{"source":"app.js:9","stack":"at x"}`},
		store.Event{Ts: t0 + 5500, Kind: store.KindError, Path: "/home", Name: "fp2", Label: "other", Props: `{bad`},
		store.Event{Ts: t0 + 6000, Kind: store.KindDead, Path: "/checkout", Name: "#noop", Label: "Nothing"},
		store.Event{Ts: t0 + 7000, Kind: store.KindRage, Path: "/checkout", Name: "#pay", Label: "Pay now", Value: 3},
		store.Event{Ts: t0 + 8000, Kind: store.KindRequest, Name: "POST api/cart", Value: 100, Num: 500},
		store.Event{Ts: t0 + 8500, Kind: store.KindRequest, Name: "POST api/cart", Value: 200, Num: 0},
		store.Event{Ts: t0 + 9000, Kind: store.KindRequest, Name: "GET api/slow", Value: 4000, Num: 200},
		store.Event{Ts: t0 + 9100, Kind: store.KindVital, Path: "/checkout", Name: "lcp", Value: 3000},
		store.Event{Ts: t0 + 9200, Kind: store.KindVital, Path: "/checkout", Name: "lcp", Value: 2000},
		store.Event{Ts: t0 + 9300, Kind: store.KindVital, Path: "/home", Name: "lcp", Value: 500},
		store.Event{Ts: t0 + 9400, Kind: store.KindVital, Path: "/home", Name: "ttfb", Value: 80},
		pageEv(t0+9500, "/home"))
	n1.StartedAt, n1.Browser, n1.OS = t0+4000, "Firefox", "Linux"
	apply(t, s, old, rec, n1)
	q := window(p, t0-hour, t0+hour)

	groups, err := s.ErrorGroups(ctx, q)
	must(t, err)
	eq(t, "error groups", len(groups), 2)
	fp1 := store.ErrorGroup{Fingerprint: "fp1", Message: "new message", Source: "app.js:9", Count: 2, Visits: 2,
		FirstSeen: t0 - 5*day, LastSeen: t0 + 5000, Path: "/checkout"}
	eq(t, "error group", groups[0], fp1)
	eq(t, "bad props", groups[1], store.ErrorGroup{Fingerprint: "fp2", Message: "other", Count: 1, Visits: 1, FirstSeen: t0 + 5500, LastSeen: t0 + 5500, Path: "/home"})
	fq := q
	fq.Filter = store.VisitFilter{Browser: "Chrome"}
	groups, _ = s.ErrorGroups(ctx, fq)
	eq(t, "filtered error groups", len(groups), 1)
	eq(t, "filtered error message", groups[0].Message, "old message")
	eq(t, "filtered error count", groups[0].Count, 1)

	g, occ, err := s.ErrorGroup(ctx, q, "fp1")
	must(t, err)
	eq(t, "one error group", g, fp1)
	eq(t, "occurrences", len(occ), 2)
	eq(t, "latest occurrence", occ[0], store.Occurrence{VisitID: "n1", Ts: t0 + 5000, Path: "/checkout", Label: "new message",
		Props: `{"source":"app.js:9","stack":"at x"}`, Browser: "Firefox", OS: "Linux"})
	eq(t, "recorded occurrence", occ[1], store.Occurrence{VisitID: sid, Ts: t0 + 1000, Path: "/checkout", Label: "old message",
		Props: `{"source":"app.js:1"}`, Browser: "Chrome", OS: "macOS", Release: "v2", Recorded: true, StartedAt: t0})
	if _, _, err := s.ErrorGroup(ctx, q, "missing"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("missing error group: %v", err)
	}
	if _, _, err := s.ErrorGroup(ctx, window(p, t0+day, t0+2*day), "fp1"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("error group outside the window: %v", err)
	}

	fr, err := s.Friction(ctx, q)
	must(t, err)
	eq(t, "friction pages", fmt.Sprint(fr.Pages), fmt.Sprint([]store.PageFriction{
		{Path: "/checkout", Visits: 2, Rage: 2, Dead: 1, Errors: 2}, {Path: "/home", Visits: 1, Errors: 1}}))
	eq(t, "friction elements", fmt.Sprint(fr.Elements), fmt.Sprint([]store.ElementFriction{
		{Kind: "rage", Path: "/checkout", Selector: "#pay", Label: "Pay now", Count: 2, Visits: 2, VisitID: "n1", Ts: t0 + 7000},
		{Kind: "dead", Path: "/checkout", Selector: "#noop", Label: "Nothing", Count: 1, Visits: 1, VisitID: "n1", Ts: t0 + 6000}}))
	fr, _ = s.Friction(ctx, window(p, t0+day, t0+2*day))
	if fr.Pages == nil || fr.Elements == nil || len(fr.Pages)+len(fr.Elements) != 0 {
		t.Fatalf("empty friction: %+v", fr)
	}

	reqs, err := s.Requests(ctx, q)
	must(t, err)
	eq(t, "requests", fmt.Sprint(reqs), fmt.Sprint([]store.RequestStat{
		{Name: "POST api/cart", Count: 3, Failed: 3, Visits: 2, AvgMs: 200, Status: 500, VisitID: "n1", Ts: t0 + 8500, LastSeen: t0 + 8500},
		{Name: "GET api/slow", Count: 1, Visits: 1, AvgMs: 4000, VisitID: "n1", Ts: t0 + 9000, LastSeen: t0 + 9000}}))

	vitals, err := s.Vitals(ctx, q)
	must(t, err)
	eq(t, "vitals", fmt.Sprint(vitals), fmt.Sprint([]store.PageVitals{
		{Path: "", Samples: 5, LCP: 3000, INP: -1, CLS: 0.1, FCP: -1, TTFB: 80},
		{Path: "/checkout", Samples: 4, LCP: 3000, INP: -1, CLS: 0.1, FCP: -1, TTFB: -1},
		{Path: "/home", Samples: 1, LCP: 500, INP: -1, CLS: -1, FCP: -1, TTFB: 80}}))
	vitals, _ = s.Vitals(ctx, fq)
	eq(t, "filtered vitals", vitals[0].LCP, 4000)
	vitals, _ = s.Vitals(ctx, window(p, t0+day, t0+2*day))
	if vitals == nil || len(vitals) != 0 {
		t.Fatalf("empty vitals: %v", vitals)
	}

	must(t, s.DeleteRecording(ctx, p.ID, sid, t0))
	_, occ, err = s.ErrorGroup(ctx, q, "fp1")
	must(t, err)
	eq(t, "occurrence of a deleted recording", occ[1].Recorded, false)
}

func testHeatmap(t *testing.T, s store.Store) {
	org, _ := seedOrg(t, s)
	p := seedProject(t, s, org.ID, "shop")
	t0 := base + 10*hour
	sid := store.NewID()
	must(t, s.ApplyFlush(ctx, []store.IngestBlock{batch(p, sid, "anon-d", 0, t0)}, t0))
	click := func(ts int64, name, label string, x, y, w int) store.Event {
		return store.Event{Ts: ts, Kind: store.KindClick, Path: "/landing", Name: name, Label: label, X: x, Y: y, W: w}
	}
	leave := func(ts int64, scroll, height, w int) store.Event {
		return store.Event{Ts: ts, Kind: store.KindLeave, Path: "/landing", Value: 1000, Num: scroll, Y: height, W: w}
	}
	desktop := hit(p, sid, "anon-d", t0, pageEv(t0+500, "/landing"),
		click(t0+1000, "#cta", "Start", 5050, 105, 1440), click(t0+2000, "#cta", "Start now", 5099, 109, 1440),
		click(t0+3000, "#edge", "Edge", 10000, 0, 1440), leave(t0+4000, 60, 3000, 1440), leave(t0+5000, 90, 3200, 1440),
		click(t0+6000, "#else", "Elsewhere", 1, 1, 1440))
	desktop.Events[len(desktop.Events)-1].Path = "/other"
	mobile := hit(p, "m1", "m", t0+hour, pageEv(t0+hour, "/landing"), click(t0+hour+1000, "#menu", "Menu", 100, 55, 390), leave(t0+hour+2000, 20, 5000, 390))
	apply(t, s, desktop, mobile)

	pages, err := s.HeatmapPages(ctx, window(p, base, base+day))
	must(t, err)
	eq(t, "heatmap pages", fmt.Sprint(pages), fmt.Sprint([]store.PathCount{{Path: "/landing", Count: 4}, {Path: "/other", Count: 1}}))

	q := store.HeatmapQuery{ProjectID: p.ID, From: base, To: base + day, Path: "/landing"}
	h, err := s.Heatmap(ctx, q)
	must(t, err)
	eq(t, "clicks", h.Clicks, 4)
	eq(t, "cells", fmt.Sprint(h.Cells), fmt.Sprint([]store.HeatCell{{X: 50, Y: 10, N: 2}, {X: 1, Y: 5, N: 1}, {X: 99, Y: 0, N: 1}}))
	eq(t, "elements", fmt.Sprint(h.Elements), fmt.Sprint([]store.HeatElement{
		{Selector: "#cta", Label: "Start now", Count: 2}, {Selector: "#edge", Label: "Edge", Count: 1}, {Selector: "#menu", Label: "Menu", Count: 1}}))
	eq(t, "views", h.Views, 3)
	eq(t, "scroll", h.Scroll, [10]int{3, 3, 2, 2, 2, 2, 1, 1, 1, 0})
	eq(t, "height", h.Height, 3733) // the average page
	eq(t, "width", h.Width, 1090)   // the average over phones and desktops
	if h.Snapshot == nil {
		t.Fatal("no snapshot")
	}
	eq(t, "snapshot", *h.Snapshot, store.HeatmapSource{RecordingID: sid, Ts: t0 + 500, StartedAt: t0})

	q.Device = "Mobile"
	h, _ = s.Heatmap(ctx, q)
	eq(t, "mobile clicks", h.Clicks, 1)
	eq(t, "mobile cells", fmt.Sprint(h.Cells), fmt.Sprint([]store.HeatCell{{X: 1, Y: 5, N: 1}}))
	eq(t, "mobile views", h.Views, 1)
	eq(t, "mobile scroll", h.Scroll, [10]int{1, 1})
	eq(t, "mobile height", h.Height, 5000)
	eq(t, "mobile width", h.Width, 390)
	if h.Snapshot != nil {
		t.Fatal("the only recording is a desktop one")
	}
	q.Device = "Desktop"
	h, _ = s.Heatmap(ctx, q)
	eq(t, "desktop clicks", h.Clicks, 3)
	eq(t, "desktop views", h.Views, 2) // two stays on the page by one visit
	if h.Snapshot == nil {
		t.Fatal("no desktop snapshot")
	}
	q.Device = "Tablet"
	h, err = s.Heatmap(ctx, q)
	must(t, err)
	eq(t, "tablet clicks", h.Clicks, 0)
	if h.Cells == nil || h.Elements == nil || len(h.Cells) != 0 || h.Snapshot != nil {
		t.Fatalf("empty heatmap: %+v", h)
	}

	q.Device = ""
	must(t, s.DeleteRecording(ctx, p.ID, sid, t0))
	h, _ = s.Heatmap(ctx, q)
	if h.Snapshot != nil {
		t.Fatal("snapshot of a deleted recording")
	}
}

func testRetention(t *testing.T, s store.Store) {
	org, _ := seedOrg(t, s)
	p := seedProject(t, s, org.ID, "shop")
	n := 0
	visit := func(visitor string, at int64) store.Hit {
		n++
		return hit(p, fmt.Sprint("r", n), visitor, at, pageEv(0, "/"))
	}
	daily := visit("", base+16*day+2*hour)
	daily.VisitorKey, daily.Cookieless = "h:zz", true
	apply(t, s,
		visit("D", base-10*day), visit("A", base+day), visit("D", base+day), visit("B", base+2*day),
		visit("A", base+8*day), visit("C", base+9*day), visit("A", base+15*day), visit("A", base+15*day+hour),
		visit("B", base+16*day+hour), daily)

	now := base + 17*day
	r, err := s.Retention(ctx, store.RetentionQuery{ProjectID: p.ID, Now: now, Weeks: 3})
	must(t, err)
	eq(t, "daily", r.Daily, 1)
	eq(t, "weekly", r.Weekly, 2)
	eq(t, "monthly", r.Monthly, 4)
	eq(t, "cohorts", fmt.Sprint(r.Cohorts), fmt.Sprint([]store.Cohort{
		{Week: "2026-06-01", Size: 2, Active: []int{2, 1, 2}},
		{Week: "2026-06-08", Size: 1, Active: []int{1, 0}},
		{Week: "2026-06-15", Size: 0, Active: []int{0}}}))

	r, err = s.Retention(ctx, store.RetentionQuery{ProjectID: p.ID, Now: now})
	must(t, err)
	eq(t, "default weeks", len(r.Cohorts), 8)
	eq(t, "oldest cohort first", r.Cohorts[0].Week, "2026-04-27")
	eq(t, "first seen before the first week", r.Cohorts[3].Week+fmt.Sprint(r.Cohorts[3].Size, r.Cohorts[3].Active), "2026-05-18"+"1 [1 0 1 0 0]")

	// Two hours east, Sunday 23:00 UTC already belongs to Monday's week.
	apply(t, s, visit("E", base+7*day-hour))
	r, _ = s.Retention(ctx, store.RetentionQuery{ProjectID: p.ID, Now: now, Weeks: 3})
	eq(t, "utc week", r.Cohorts[0].Size, 3)
	r, _ = s.Retention(ctx, store.RetentionQuery{ProjectID: p.ID, Now: now, Weeks: 3, DayOffsetMs: 2 * hour})
	eq(t, "shifted week", fmt.Sprint(r.Cohorts[0].Size, r.Cohorts[1].Size), "2 2")
	eq(t, "shifted label", r.Cohorts[1].Week, "2026-06-08")

	r, err = s.Retention(ctx, store.RetentionQuery{ProjectID: "nope", Now: now})
	must(t, err)
	eq(t, "empty retention", fmt.Sprint(r.Monthly, len(r.Cohorts), r.Cohorts[7].Active), "0 8 [0]")
}

func testInsights(t *testing.T, s store.Store) {
	org, _ := seedOrg(t, s)
	p := seedProject(t, s, org.ID, "shop")
	other := seedProject(t, s, org.ID, "other")
	ids := make([]string, 5)
	for i := range ids {
		ids[i] = store.NewID()
	}
	s0 := batch(p, ids[0], "r1", 0, base-3*day)
	s0.Release = "v1"
	s1 := batch(p, ids[1], "r1", 0, base+hour)
	s1.Release, s1.Errors, s1.Email = "v1", 1, "ann@acme.dev"
	s1.Path, s1.Paths = "/checkout", []string{"/", "/checkout"}
	s2 := batch(p, ids[2], "r2", 0, base+2*hour)
	s2.Release, s2.RageClicks, s2.Email = "v1", 1, "Bob@Acme.dev"
	s2.Browser, s2.OS, s2.CountryCode = "Firefox", "Linux", "GB"
	s3 := batch(p, ids[3], "r3", 0, base+3*hour)
	s3.Release, s3.Email = "v2", "someone@gmail.com"
	s4 := batch(p, ids[4], "r4", 0, base+4*hour)
	s4.DeadClicks, s4.Pageviews, s4.ActiveMs, s4.Email = 1, 30, 3*minute, "cy@other.io"
	must(t, s.ApplyFlush(ctx, []store.IngestBlock{s0, s1, s2, s3, s4}, base))

	q := window(p, base, base+day)
	q.Filter = store.VisitFilter{Country: "ZZ"} // releases come from recordings: the visit filter does not apply
	rel, err := s.Releases(ctx, q)
	must(t, err)
	eq(t, "releases", fmt.Sprint(rel), fmt.Sprint([]store.ReleaseStat{
		{Release: "v2", FirstSeen: base + 3*hour, LastSeen: base + 3*hour + 1000, Sessions: 1},
		{Release: "v1", FirstSeen: base - 3*day, LastSeen: base + 2*hour + 1000, Sessions: 2, Errors: 1, Friction: 1}}))
	rel, _ = s.Releases(ctx, window(other, base, base+day))
	if rel == nil || len(rel) != 0 {
		t.Fatalf("releases of an empty project: %v", rel)
	}

	acc, err := s.Accounts(ctx, p.ID)
	must(t, err)
	eq(t, "accounts", fmt.Sprint(acc), fmt.Sprint([]store.Account{
		{Domain: "other.io", People: 1, Sessions: 1, LastSeen: base + 4*hour + 1000},
		{Domain: "acme.dev", People: 2, Sessions: 3, LastSeen: base + 2*hour + 1000}}))
	acc, _ = s.Accounts(ctx, other.ID)
	if acc == nil || len(acc) != 0 {
		t.Fatalf("accounts of an empty project: %v", acc)
	}

	byID := func(project string, ids ...string) string {
		t.Helper()
		recs, err := s.RecordingsByID(ctx, project, ids)
		must(t, err)
		if recs == nil {
			t.Fatal("recordings must not be nil")
		}
		got := make([]string, len(recs))
		for i, r := range recs {
			got[i] = r.ID
		}
		return fmt.Sprint(got)
	}
	eq(t, "recordings by id", byID(p.ID, ids[1], ids[3], "nope", ids[2]), fmt.Sprint([]string{ids[3], ids[2], ids[1]}))
	eq(t, "recordings of another project", byID(other.ID, ids[1]), "[]")
	eq(t, "no ids", byID(p.ID), "[]")

	// The visits of two of the recordings carry what a recording does not.
	v1 := hit(p, ids[1], "r1", base+hour, pageEv(0, "/"),
		store.Event{Kind: store.KindError, Path: "/checkout", Name: "fp1", Label: "boom"},
		store.Event{Kind: store.KindTrack, Path: "/checkout", Name: "signup"})
	v1.Referrer, v1.Channel, v1.UTMSource, v1.UTMCampaign, v1.Language = "news.ycombinator.com", "Referral", "hn", "launch", "de"
	v2 := hit(p, ids[2], "r2", base+2*hour, pageEv(0, "/p0"))
	apply(t, s, v1, v2)

	cases := []struct {
		q    store.RecordingQuery
		want int
	}{
		{store.RecordingQuery{}, 5},
		{store.RecordingQuery{Entry: "/"}, 1},
		{store.RecordingQuery{Exit: "/checkout"}, 1},
		{store.RecordingQuery{Path: "/checkout"}, 1},
		{store.RecordingQuery{Path: "/check"}, 0},
		{store.RecordingQuery{Path: "/p0"}, 4},
		{store.RecordingQuery{Country: "GB"}, 1},
		{store.RecordingQuery{Browser: "Firefox", OS: "Linux"}, 1},
		{store.RecordingQuery{Browser: "Firefox", OS: "macOS"}, 0},
		{store.RecordingQuery{Release: "v1"}, 3},
		{store.RecordingQuery{Referrer: "news.ycombinator.com"}, 1},
		{store.RecordingQuery{Referrer: "Direct"}, 1},
		{store.RecordingQuery{Channel: "Referral"}, 1},
		{store.RecordingQuery{UTMSource: "hn", UTMCampaign: "launch"}, 1},
		{store.RecordingQuery{UTMSource: "hn", UTMCampaign: "other"}, 0},
		{store.RecordingQuery{Language: "de"}, 1},
		{store.RecordingQuery{Language: "en"}, 1},
		{store.RecordingQuery{EventKind: store.KindError}, 1},
		{store.RecordingQuery{EventKind: store.KindError, EventName: "fp1", EventPath: "/checkout"}, 1},
		{store.RecordingQuery{EventKind: store.KindError, EventName: "zzz"}, 0},
		{store.RecordingQuery{EventKind: store.KindError, EventPath: "/"}, 0},
		{store.RecordingQuery{EventKind: store.KindTrack, EventName: "signup"}, 1},
		{store.RecordingQuery{EventKind: store.KindPage}, 2},
		{store.RecordingQuery{Release: "v1", View: "friction"}, 2},
		{store.RecordingQuery{Release: "v1", Errors: true, Language: "de"}, 1},
	}
	for i, c := range cases {
		c.q.ProjectID = p.ID
		page, err := s.ListRecordings(ctx, c.q)
		must(t, err)
		eq(t, fmt.Sprintf("recordings case %d total", i), page.Total, c.want)
		eq(t, fmt.Sprintf("recordings case %d items", i), len(page.Items), c.want)
	}
	// The tab counts follow the filters, as they do for the older ones.
	page, err := s.ListRecordings(ctx, store.RecordingQuery{ProjectID: p.ID, Release: "v1", View: "starred"})
	must(t, err)
	eq(t, "counts under a filter", page.Counts, store.RecordingCounts{All: 3, Unwatched: 3, Friction: 2})

	order := func(q store.RecordingQuery) string {
		t.Helper()
		q.ProjectID = p.ID
		page, err := s.ListRecordings(ctx, q)
		must(t, err)
		var b strings.Builder
		for _, r := range page.Items {
			fmt.Fprint(&b, slices.Index(ids, r.ID))
		}
		return b.String()
	}
	eq(t, "newest first", order(store.RecordingQuery{}), "43210")
	// Scores: s4 2+10+3, s1 5+1, s2 4+1, the others 1.
	eq(t, "score order", order(store.RecordingQuery{Sort: "score"}), "41230")
	eq(t, "score order, second page", order(store.RecordingQuery{Sort: "score", Limit: 2, Page: 1}), "23")
	eq(t, "score order with a filter", order(store.RecordingQuery{Sort: "score", Release: "v1"}), "120")
}

func testDaySalt(t *testing.T, s store.Store) {
	a, err := s.DaySalt(ctx, "2026-06-01")
	must(t, err)
	if len(a) < 16 {
		t.Fatalf("salt %q is too short", a)
	}
	again, err := s.DaySalt(ctx, "2026-06-01")
	must(t, err)
	eq(t, "stable within a day", again, a)
	b, err := s.DaySalt(ctx, "2026-06-02")
	must(t, err)
	if b == a {
		t.Fatal("two days share a salt")
	}
	again, _ = s.DaySalt(ctx, "2026-06-02")
	eq(t, "second day is stable", again, b)
	// Asking for the second day forgot the first: it gets a new salt.
	old, err := s.DaySalt(ctx, "2026-06-01")
	must(t, err)
	if old == a {
		t.Fatal("an earlier day's salt was kept")
	}
	again, _ = s.DaySalt(ctx, "2026-06-02")
	eq(t, "a later day survives", again, b)
}

func testAttachments(t *testing.T, s store.Store) {
	org, owner := seedOrg(t, s)
	p := seedProject(t, s, org.ID, "shop")
	other := seedProject(t, s, org.ID, "other")
	sid := store.NewID()
	must(t, s.ApplyFlush(ctx, []store.IngestBlock{batch(p, sid, "anon-1", 0, base)}, base))

	// Notes.
	late := store.Note{ID: store.NewID(), OrgID: org.ID, ProjectID: p.ID, SessionID: sid, UserID: owner.ID, AtMs: 5000, Body: "second", CreatedAt: base}
	early := store.Note{ID: store.NewID(), OrgID: org.ID, ProjectID: p.ID, SessionID: sid, UserID: "gone", AtMs: 1000, Body: "first", CreatedAt: base + 1}
	must(t, s.CreateNote(ctx, late))
	must(t, s.CreateNote(ctx, early))
	notes, err := s.ListNotes(ctx, p.ID, sid)
	must(t, err)
	eq(t, "notes", len(notes), 2)
	eq(t, "notes in playback order", notes[0].Body+notes[1].Body, "firstsecond")
	eq(t, "note author", notes[1].Author, "Ada")
	eq(t, "note of a removed user", notes[0].Author, "")
	eq(t, "note fields", notes[1], store.Note{ID: late.ID, SessionID: sid, UserID: owner.ID, Author: "Ada", AtMs: 5000, Body: "second", CreatedAt: base})
	notes, _ = s.ListNotes(ctx, other.ID, sid)
	if notes == nil || len(notes) != 0 {
		t.Fatalf("notes of another project: %v", notes)
	}
	if err := s.DeleteNote(ctx, other.ID, early.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("delete another project's note: %v", err)
	}
	must(t, s.DeleteNote(ctx, p.ID, early.ID))
	if err := s.DeleteNote(ctx, p.ID, early.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("delete a note twice: %v", err)
	}
	notes, _ = s.ListNotes(ctx, p.ID, sid)
	eq(t, "notes left", len(notes), 1)

	// Share links.
	share := func(kind, session, hash string, expires int64) store.Share {
		sh := store.Share{ID: store.NewID(), OrgID: org.ID, ProjectID: p.ID, Kind: kind, SessionID: session, StartMs: 1500,
			TokenHash: hash, CreatedBy: owner.ID, CreatedAt: base + int64(len(hash)), ExpiresAt: expires}
		must(t, s.CreateShare(ctx, sh))
		return sh
	}
	rec := share(store.ShareRecording, sid, "h-rec", base+day)
	dash := share(store.ShareDashboard, "", "h-dash-1", base+2*day)
	share(store.ShareRecording, sid, "h-expired", base-1)
	shares, err := s.ListShares(ctx, p.ID, base)
	must(t, err)
	eq(t, "shares", len(shares), 2)
	eq(t, "newest share first", shares[0].ID, dash.ID)
	got, err := s.GetShareByHash(ctx, "h-rec", base)
	must(t, err)
	want := rec
	want.TokenHash, want.Author = "", "Ada"
	eq(t, "share", got, want)
	for _, c := range []struct {
		hash string
		now  int64
	}{{"h-expired", base}, {"h-rec", base + day}, {"h-nope", base}} {
		if _, err := s.GetShareByHash(ctx, c.hash, c.now); !errors.Is(err, store.ErrNotFound) {
			t.Fatalf("share %s at %d: %v", c.hash, c.now-base, err)
		}
	}
	shares, _ = s.ListShares(ctx, p.ID, base+day)
	eq(t, "shares after one expired", len(shares), 1)
	if err := s.DeleteShare(ctx, other.ID, rec.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("delete another project's share: %v", err)
	}

	// Feedback.
	f1 := store.Feedback{ID: store.NewID(), OrgID: org.ID, ProjectID: p.ID, VisitID: sid, VisitorKey: "a:anon-1", Path: "/pricing",
		Body: "too expensive", Email: "a@b.c", CreatedAt: base + 1000}
	f2 := store.Feedback{ID: store.NewID(), OrgID: org.ID, ProjectID: p.ID, VisitID: "unrecorded", VisitorKey: "h:zz", Path: "/", Body: "nice", CreatedAt: base + 2000}
	must(t, s.CreateFeedback(ctx, f1))
	must(t, s.CreateFeedback(ctx, f2))
	fb, err := s.ListFeedback(ctx, p.ID, 0, 10)
	must(t, err)
	eq(t, "feedback total", fb.Total, 2)
	eq(t, "feedback unseen", fb.Unseen, 2)
	eq(t, "newest feedback first", fb.Items[0], store.Feedback{ID: f2.ID, VisitID: "unrecorded", Path: "/", Body: "nice", CreatedAt: base + 2000})
	eq(t, "recorded feedback", fb.Items[1], store.Feedback{ID: f1.ID, VisitID: sid, Path: "/pricing", Body: "too expensive", Email: "a@b.c",
		CreatedAt: base + 1000, Recorded: true, StartedAt: base})
	must(t, s.SetFeedbackSeen(ctx, p.ID, f1.ID, true))
	fb, _ = s.ListFeedback(ctx, p.ID, 1, 1)
	eq(t, "feedback unseen after reading", fb.Unseen, 1)
	eq(t, "feedback second page", len(fb.Items), 1)
	eq(t, "feedback seen", fb.Items[0].Seen, true)
	must(t, s.SetFeedbackSeen(ctx, p.ID, f1.ID, false))
	fb, _ = s.ListFeedback(ctx, p.ID, 0, 10)
	eq(t, "feedback unseen again", fb.Unseen, 2)
	if err := s.SetFeedbackSeen(ctx, other.ID, f1.ID, true); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("mark another project's feedback: %v", err)
	}
	must(t, s.DeleteFeedback(ctx, p.ID, f2.ID))
	if err := s.DeleteFeedback(ctx, p.ID, f2.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("delete feedback twice: %v", err)
	}
	fb, _ = s.ListFeedback(ctx, other.ID, 0, 10)
	if fb.Items == nil || fb.Total != 0 {
		t.Fatalf("feedback of another project: %+v", fb)
	}

	// State.
	v, err := s.GetState(ctx, p.ID, "digest")
	must(t, err)
	eq(t, "unset state", v, "")
	must(t, s.SetState(ctx, p.ID, "digest", "1", base))
	must(t, s.SetState(ctx, p.ID, "digest", "2", base+1))
	must(t, s.SetState(ctx, other.ID, "digest", "other", base))
	v, _ = s.GetState(ctx, p.ID, "digest")
	eq(t, "state", v, "2")
	v, _ = s.GetState(ctx, p.ID, "alerts")
	eq(t, "another name", v, "")

	// A recording link dies with its recording; a dashboard link does not.
	must(t, s.DeleteRecording(ctx, p.ID, sid, base))
	if _, err := s.GetShareByHash(ctx, "h-rec", base); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("share of a deleted recording: %v", err)
	}
	shares, _ = s.ListShares(ctx, p.ID, base)
	eq(t, "shares after the recording went", len(shares), 1)
	fb, _ = s.ListFeedback(ctx, p.ID, 0, 10)
	eq(t, "feedback of a deleted recording", fb.Items[0].Recorded, false)
	_, err = s.GetShareByHash(ctx, "h-dash-1", base)
	must(t, err)
	must(t, s.DeleteShare(ctx, p.ID, rec.ID))
	if err := s.DeleteShare(ctx, p.ID, rec.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("delete a share twice: %v", err)
	}

	// Everything goes with the project.
	apply(t, s, hit(p, "v1", "A", base+hour, pageEv(0, "/")))
	must(t, s.DeleteProject(ctx, org.ID, p.ID, base))
	if _, err := s.GetShareByHash(ctx, "h-dash-1", base); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("share of a deleted project: %v", err)
	}
	eq(t, "visits of a deleted project", traffic(t, s, window(p, base, base+day)).Totals.Visits, 0)
	n, _ := s.CountEvents(ctx, p.ID, store.KindPage, 0)
	eq(t, "events of a deleted project", n, 0)
	fb, _ = s.ListFeedback(ctx, p.ID, 0, 10)
	eq(t, "feedback of a deleted project", fb.Total, 0)
	notes, _ = s.ListNotes(ctx, p.ID, sid)
	eq(t, "notes of a deleted project", len(notes), 0)
	shares, _ = s.ListShares(ctx, p.ID, base)
	eq(t, "shares of a deleted project", len(shares), 0)
	v, _ = s.GetState(ctx, p.ID, "digest")
	eq(t, "state of a deleted project", v, "")
	v, _ = s.GetState(ctx, other.ID, "digest")
	eq(t, "state of the other project", v, "other")
}

func testAnalyticsDeletes(t *testing.T, s store.Store) {
	org, owner := seedOrg(t, s)
	p := seedProject(t, s, org.ID, "shop")
	sid := store.NewID()
	must(t, s.ApplyFlush(ctx, []store.IngestBlock{batch(p, sid, "anon-v", 0, base+hour)}, base))
	rec, err := s.GetRecording(ctx, p.ID, sid)
	must(t, err)

	apply(t, s,
		hit(p, sid, "anon-v", base+hour, pageEv(0, "/"), ev(store.KindTrack, 0, "/", "signup")),
		hit(p, "unrecorded", "anon-v", base+2*hour, pageEv(0, "/again")),
		hit(p, "someone", "anon-w", base+3*hour, pageEv(0, "/")),
		hit(p, "ancient", "anon-w", base-10*day, pageEv(0, "/"), ev(store.KindTrack, 0, "/", "signup")))
	feedback := func(visit, key string, at int64) {
		must(t, s.CreateFeedback(ctx, store.Feedback{ID: store.NewID(), OrgID: org.ID, ProjectID: p.ID, VisitID: visit, VisitorKey: key, Body: "hi", CreatedAt: at}))
	}
	feedback(sid, "", base+hour)
	feedback("unrecorded", "a:anon-v", base+2*hour)
	feedback("someone", "a:anon-w", base+3*hour)
	feedback("ancient", "a:anon-w", base-10*day)
	must(t, s.CreateNote(ctx, store.Note{ID: store.NewID(), OrgID: org.ID, ProjectID: p.ID, SessionID: sid, UserID: owner.ID, Body: "look", CreatedAt: base}))
	must(t, s.CreateShare(ctx, store.Share{ID: store.NewID(), OrgID: org.ID, ProjectID: p.ID, Kind: store.ShareRecording, SessionID: sid,
		TokenHash: "h1", CreatedBy: owner.ID, CreatedAt: base, ExpiresAt: base + 30*day}))
	all := window(p, base-30*day, base+day)
	eq(t, "visits before", traffic(t, s, all).Totals.Visits, 4)

	// Old analytics go by age.
	n, err := s.DeleteAnalyticsBefore(ctx, p.ID, base-5*day)
	must(t, err)
	eq(t, "old visits deleted", n, 1)
	eq(t, "visits after the cut", traffic(t, s, all).Totals.Visits, 3)
	events, _ := s.CountEvents(ctx, p.ID, store.KindTrack, 0)
	eq(t, "events after the cut", events, 1)
	fb, _ := s.ListFeedback(ctx, p.ID, 0, 10)
	eq(t, "feedback after the cut", fb.Total, 3)
	n, _ = s.DeleteAnalyticsBefore(ctx, p.ID, base-5*day)
	eq(t, "nothing old is left", n, 0)

	// Erasing a visitor takes their visits, recorded or not, and what hangs
	// on their recordings.
	must(t, s.DeleteVisitor(ctx, p.ID, rec.Visitor.ID, base))
	tr := traffic(t, s, all)
	eq(t, "visits after erasing a visitor", tr.Totals.Visits, 1)
	eq(t, "the other visitor stays", tr.EntryPages[0].Visits, 1)
	events, _ = s.CountEvents(ctx, p.ID, store.KindPage, 0)
	eq(t, "page events after erasing", events, 1)
	events, _ = s.CountEvents(ctx, p.ID, store.KindTrack, 0)
	eq(t, "track events after erasing", events, 0)
	fb, _ = s.ListFeedback(ctx, p.ID, 0, 10)
	eq(t, "feedback after erasing", fb.Total, 1)
	eq(t, "the other visitor's feedback stays", fb.Items[0].VisitID, "someone")
	notes, _ := s.ListNotes(ctx, p.ID, sid)
	eq(t, "notes after erasing", len(notes), 0)
	if _, err := s.GetShareByHash(ctx, "h1", base); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("share of an erased visitor: %v", err)
	}
	shares, _ := s.ListShares(ctx, p.ID, base)
	eq(t, "shares after erasing", len(shares), 0)
}
