package storetest

import (
	"fmt"
	"math/rand/v2"
	"testing"

	"github.com/dimmihq/kimmi/internal/store"
)

// testDailyAgrees checks the daily tables against the visits and events
// they are summed from: a report read from them (no filter) must equal the
// same report worked out from the rows (a filter every visit matches),
// however the visits were cut into hits and flushes.
func testDailyAgrees(t *testing.T, s store.Store) {
	org, _ := seedOrg(t, s)
	p := seedProject(t, s, org.ID, "shop")
	rnd := rand.New(rand.NewPCG(7, 11))
	paths := []string{"/", "/pricing", "/cart", "/checkout", "/thanks"}
	sources := []string{"", "google.com", "t.co", "news.example"}

	funnel := store.Funnel{ID: "f1", Steps: []store.Step{{Kind: "page", Value: "/"}, {Kind: "page", Value: "/c*"}, {Kind: "event", Value: "signup"}}}
	// 240 visits by 150 visitors over three days, each sent as one to four
	// hits; the hits of all visits are shuffled into flushes of thirty.
	var hits []store.Hit
	seen := map[string]bool{}
	for v := range 240 {
		visitor := fmt.Sprintf("v%d", rnd.IntN(150))
		start := base + int64(rnd.IntN(3))*day + int64(rnd.IntN(20))*hour + int64(v)
		source := sources[rnd.IntN(len(sources))]
		ts := start
		for part := range 1 + rnd.IntN(4) {
			var events []store.Event
			for range rnd.IntN(4) {
				ts += int64(1000 + rnd.IntN(20_000))
				path := paths[rnd.IntN(len(paths))]
				switch rnd.IntN(9) {
				case 0, 1, 2, 3:
					events = append(events, pageEv(ts, path), leaveEv(ts+500, path, float64(rnd.IntN(9000)), rnd.IntN(101)))
				case 4:
					e := ev(store.KindTrack, ts, path, []string{"signup", "add_to_cart"}[rnd.IntN(2)])
					e.Value = float64(rnd.IntN(50))
					events = append(events, e)
				case 5:
					e := ev(store.KindError, ts, path, []string{"fp-a", "fp-b"}[rnd.IntN(2)])
					e.Label, e.Props = "boom", `{"source":"app.js"}`
					events = append(events, e)
				case 6:
					e := ev([]string{store.KindRage, store.KindDead}[rnd.IntN(2)], ts, path, "button.buy")
					e.Label = "Buy"
					events = append(events, e)
				case 7:
					e := ev(store.KindRequest, ts, path, "GET api.example/stock")
					e.Value, e.Num = float64(100+rnd.IntN(900)), []int{200, 404, 500}[rnd.IntN(3)]
					events = append(events, e)
				case 8:
					e := ev(store.KindClick, ts, path, "a.cta")
					e.X, e.Y, e.W = rnd.IntN(10000), rnd.IntN(2000), 1440
					events = append(events, e)
				}
			}
			ts += 1000
			h := hit(p, fmt.Sprintf("visit-%d", v), visitor, ts, events...)
			h.StartedAt, h.Referrer, h.Funnels = start, source, []store.Funnel{funnel}
			_ = part
			hits = append(hits, h)
		}
		seen[visitor] = true
	}
	// Hits of one visit stay in order; visits interleave.
	byVisit := map[string][]store.Hit{}
	var order []string
	for _, h := range hits {
		if _, ok := byVisit[h.VisitID]; !ok {
			order = append(order, h.VisitID)
		}
		byVisit[h.VisitID] = append(byVisit[h.VisitID], h)
	}
	var flush []store.Hit
	for len(order) > 0 {
		i := rnd.IntN(len(order))
		id := order[i]
		flush = append(flush, byVisit[id][0])
		if byVisit[id] = byVisit[id][1:]; len(byVisit[id]) == 0 {
			order = append(order[:i], order[i+1:]...)
		}
		if len(flush) == 30 || len(order) == 0 {
			apply(t, s, flush...)
			flush = nil
		}
	}

	q := store.AnalyticsQuery{ProjectID: p.ID, From: base, To: base + 4*day, PrevFrom: base - 4*day}
	rows := q
	rows.Filter = store.VisitFilter{Device: "Desktop"} // every visit: forces the reports to read the rows

	fast, slow := traffic(t, s, q), traffic(t, s, rows)
	eq(t, "visitors", fast.Totals.Visitors, len(seen))
	// The average is a division on one side and the database's own on the other.
	if d := fast.Totals.AvgDurationMs - slow.Totals.AvgDurationMs; d < -1 || d > 1 {
		t.Fatalf("average duration %d, want %d", fast.Totals.AvgDurationMs, slow.Totals.AvgDurationMs)
	}
	fast.Totals.AvgDurationMs = slow.Totals.AvgDurationMs
	eq(t, "totals", fast.Totals, slow.Totals)
	eq(t, "days", fmt.Sprint(fast.Days), fmt.Sprint(slow.Days))
	eq(t, "sources", fmt.Sprint(fast.Sources), fmt.Sprint(slow.Sources))
	eq(t, "entry pages", fmt.Sprint(fast.EntryPages), fmt.Sprint(slow.EntryPages))
	// A visit leaves from one page, so the daily tables count an exit page's
	// visitors as its visits; the rows know that some came twice.
	exits := map[string]int{}
	for _, row := range slow.ExitPages {
		exits[row.Name] = row.Visits
	}
	eq(t, "exit pages", len(fast.ExitPages), len(slow.ExitPages))
	for _, row := range fast.ExitPages {
		eq(t, "exits from "+row.Name, row.Visits, exits[row.Name])
	}
	for i, page := range slow.Pages {
		got := fast.Pages[i]
		// Scroll depth is averaged per stay in the daily tables and per visit in the rows.
		got.Scroll, page.Scroll = 0, 0
		eq(t, "page "+page.Path, got, page)
	}

	names, err := s.EventNames(ctx, q)
	must(t, err)
	rawNames, err := s.EventNames(ctx, rows)
	must(t, err)
	eq(t, "tracked events", fmt.Sprint(names), fmt.Sprint(rawNames))

	groups, err := s.ErrorGroups(ctx, q)
	must(t, err)
	rawGroups, err := s.ErrorGroups(ctx, rows)
	must(t, err)
	eq(t, "error groups", len(groups), len(rawGroups))
	for i := range groups {
		eq(t, "error "+groups[i].Fingerprint, [3]int{groups[i].Count, groups[i].Visits, int(groups[i].LastSeen % 1000)},
			[3]int{rawGroups[i].Count, rawGroups[i].Visits, int(rawGroups[i].LastSeen % 1000)})
	}

	friction, err := s.Friction(ctx, q)
	must(t, err)
	rawFriction, err := s.Friction(ctx, rows)
	must(t, err)
	eq(t, "friction pages", fmt.Sprint(friction.Pages), fmt.Sprint(rawFriction.Pages))
	eq(t, "friction elements", len(friction.Elements), len(rawFriction.Elements))
	for i := range friction.Elements {
		a, b := friction.Elements[i], rawFriction.Elements[i]
		eq(t, "element", [5]any{a.Kind, a.Path, a.Selector, a.Count, a.Visits}, [5]any{b.Kind, b.Path, b.Selector, b.Count, b.Visits})
	}

	requests, err := s.Requests(ctx, q)
	must(t, err)
	rawRequests, err := s.Requests(ctx, rows)
	must(t, err)
	eq(t, "requests", [4]any{requests[0].Name, requests[0].Count, requests[0].Failed, requests[0].Visits},
		[4]any{rawRequests[0].Name, rawRequests[0].Count, rawRequests[0].Failed, rawRequests[0].Visits})

	goals := []store.Step{{Kind: "event", Value: "signup"}, {Kind: "page", Value: "/thanks"}, {Kind: "page", Value: "/c*"}}
	counts, err := s.Goals(ctx, q, goals)
	must(t, err)
	rawCounts, err := s.Goals(ctx, rows, goals)
	must(t, err)
	eq(t, "goals", fmt.Sprint(counts), fmt.Sprint(rawCounts))

	// The funnel counted as hits came in, worked out from the events, and
	// counted again over the stored visits all say the same.
	steps, err := s.Funnel(ctx, q, funnel.Steps)
	must(t, err)
	if steps[0].Visits == 0 || steps[2].Visits == 0 || steps[2].Visits >= steps[0].Visits {
		t.Fatalf("the funnel is not much of a test: %+v", steps)
	}
	check := func(what, id string) {
		t.Helper()
		got, err := s.FunnelCounts(ctx, q, id, len(funnel.Steps))
		must(t, err)
		for i := range steps {
			eq(t, fmt.Sprint(what, " step ", i), got[i].Visits, steps[i].Visits)
			eq(t, fmt.Sprint(what, " stopped after step ", i), len(got[i].Dropped), len(steps[i].Dropped))
		}
	}
	check("counted at ingest", "f1")
	later := store.Funnel{ID: "f2", Steps: funnel.Steps}
	must(t, s.BackfillFunnel(ctx, p.ID, later))
	check("counted afterwards", "f2")
	must(t, s.BackfillFunnel(ctx, p.ID, later)) // again: the same, not double
	check("counted twice", "f2")
	must(t, s.BackfillFunnel(ctx, p.ID, store.Funnel{ID: "f2"}))
	gone, err := s.FunnelCounts(ctx, q, "f2", 3)
	must(t, err)
	eq(t, "a forgotten funnel", gone[0].Visits, 0)

	hq := store.HeatmapQuery{ProjectID: p.ID, From: base, To: base + 4*day, Path: "/"}
	heat, err := s.Heatmap(ctx, hq)
	must(t, err)
	total := 0
	for _, cell := range heat.Cells {
		total += cell.N
	}
	eq(t, "every click is in a cell", total, heat.Clicks)
	if heat.Clicks == 0 {
		t.Fatal("no clicks were rolled up")
	}
}

// testCohortsAnyOrder checks that the weekly cohorts do not depend on the
// order visits arrive in: history loaded backwards gives the same table.
func testCohortsAnyOrder(t *testing.T, s store.Store) {
	org, _ := seedOrg(t, s)
	forward, backward := seedProject(t, s, org.ID, "forward"), seedProject(t, s, org.ID, "backward")
	rnd := rand.New(rand.NewPCG(3, 5))
	type visit struct {
		visitor string
		at      int64
	}
	var visits []visit
	for i := range 400 {
		visits = append(visits, visit{fmt.Sprintf("v%d", rnd.IntN(90)), base + int64(rnd.IntN(42))*day + int64(i)})
	}
	load := func(p store.Project, order []visit) {
		for i, v := range order {
			apply(t, s, hit(p, fmt.Sprintf("%s-%d-%d", p.ID, v.at, i), v.visitor, v.at, pageEv(0, "/")))
		}
	}
	sorted := append([]visit(nil), visits...)
	for i := range sorted {
		for j := i + 1; j < len(sorted); j++ {
			if sorted[j].at < sorted[i].at {
				sorted[i], sorted[j] = sorted[j], sorted[i]
			}
		}
	}
	reversed := append([]visit(nil), sorted...)
	for i, j := 0, len(reversed)-1; i < j; i, j = i+1, j-1 {
		reversed[i], reversed[j] = reversed[j], reversed[i]
	}
	load(forward, sorted)
	load(backward, reversed)
	now := base + 42*day
	a, err := s.Retention(ctx, store.RetentionQuery{ProjectID: forward.ID, Now: now, Weeks: 7})
	must(t, err)
	b, err := s.Retention(ctx, store.RetentionQuery{ProjectID: backward.ID, Now: now, Weeks: 7})
	must(t, err)
	eq(t, "cohorts", fmt.Sprint(b.Cohorts), fmt.Sprint(a.Cohorts))
	total := 0
	for _, c := range a.Cohorts {
		total += c.Size
		if len(c.Active) > 1 && c.Active[0] != c.Size {
			t.Fatalf("a cohort is all there in its own week: %+v", c)
		}
	}
	eq(t, "everyone is in one cohort", total, 90)
}
