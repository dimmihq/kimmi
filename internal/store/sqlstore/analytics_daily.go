package sqlstore

import (
	"cmp"
	"context"
	"database/sql"
	"fmt"
	"slices"
	"strconv"
	"strings"

	"github.com/dimmihq/kimmi/internal/hll"
	"github.com/dimmihq/kimmi/internal/store"
)

// The reports below read the daily tables (see rollup.go): a few rows per
// day and value, whatever the traffic. A report narrowed to some visits (a
// source, a page, a country) cannot be answered from them and reads the
// visits and events themselves, as do funnels and cohorts.

// days is the window of q as days of the project.
func days(q store.AnalyticsQuery) (from, to int64) {
	return (q.From + q.DayOffsetMs) / store.DayMs, (q.To - 1 + q.DayOffsetMs) / store.DayMs
}

func unfiltered(q store.AnalyticsQuery) bool { return q.Filter == (store.VisitFilter{}) }

// visitDims are the dimensions a traffic panel shows, with the name of an
// empty value.
var visitDims = []struct{ dim, empty string }{
	{dimSource, "Direct"}, {dimChannel, "Unknown"}, {dimCampaign, "None"}, {dimEntry, "Unknown"}, {dimExit, "Unknown"},
	{dimCountry, "Unknown"}, {dimDevice, "Unknown"}, {dimBrowser, "Unknown"}, {dimOS, "Unknown"}, {dimLanguage, "Unknown"},
}

type statRow struct {
	dim, k                                                  string
	visits, pageviews, bounces, newVisitors, scrollN, exits int
	durationMs, timeMs, scrollSum                           int64
	sketch                                                  *hll.Sketch
}

func (d *DB) Traffic(ctx context.Context, q store.AnalyticsQuery) (store.Traffic, error) {
	if !unfiltered(q) {
		return d.trafficRaw(ctx, q)
	}
	t := store.Traffic{Days: []store.TrafficDay{}, Pages: []store.PageMetric{}}
	from, to := days(q)
	index := map[int64]int{}
	for day := from; day <= to; day++ {
		index[day] = len(t.Days)
		t.Days = append(t.Days, store.TrafficDay{Date: dayLabel(day)})
	}

	// The top values of every dimension, by their sums over the window.
	rows := map[string][]*statRow{}
	err := d.each(ctx, `SELECT dim, k, v, pv, b, dur, nv, tm, ss, sn, ex FROM (
			SELECT dim, k, CAST(SUM(visits) AS BIGINT) AS v, CAST(SUM(pageviews) AS BIGINT) AS pv, CAST(SUM(bounces) AS BIGINT) AS b,
				CAST(SUM(duration_ms) AS BIGINT) AS dur, CAST(SUM(new_visitors) AS BIGINT) AS nv, CAST(SUM(time_ms) AS BIGINT) AS tm,
				CAST(SUM(scroll_sum) AS BIGINT) AS ss, CAST(SUM(scroll_n) AS BIGINT) AS sn, CAST(SUM(exits) AS BIGINT) AS ex,
				ROW_NUMBER() OVER (PARTITION BY dim ORDER BY SUM(visits) + SUM(pageviews) + SUM(exits) DESC, k) AS rn
			FROM stats_daily WHERE project_id = ? AND day >= ? AND day <= ? GROUP BY dim, k) t
		WHERE rn <= 20`, []any{q.ProjectID, from, to}, func(r *sql.Rows) error {
		var s statRow
		if err := r.Scan(&s.dim, &s.k, &s.visits, &s.pageviews, &s.bounces, &s.durationMs, &s.newVisitors, &s.timeMs, &s.scrollSum, &s.scrollN, &s.exits); err != nil {
			return err
		}
		s.sketch = hll.New(sketchPrecision(s.dim))
		rows[s.dim] = append(rows[s.dim], &s)
		return nil
	})
	if err != nil {
		return t, fmt.Errorf("traffic: %w", err)
	}

	// Their sketches, merged over the days; the totals' also day by day.
	byKey := map[[2]string]*statRow{}
	f := &filter{}
	var pick []string
	var args []any
	for dim, list := range rows {
		if dim == dimAll {
			continue
		}
		keys := make([]string, len(list))
		for i, s := range list {
			keys[i] = s.k
			byKey[[2]string{dim, s.k}] = s
		}
		pick = append(pick, "(dim = ? AND k IN ("+placeholders(len(keys))+"))")
		args = append(append(args, dim), inArgs(keys)...)
	}
	pick = append(pick, "dim IN (?, ?)")
	args = append(args, dimAll, dimReturning)
	f.add("project_id = ?", q.ProjectID)
	f.add("day >= ? AND day <= ?", from, to)
	f.add("("+strings.Join(pick, " OR ")+")", args...)
	total, returning := hll.New(sketchPrecision(dimAll)), hll.New(sketchPrecision(dimReturning))
	err = d.each(ctx, "SELECT day, dim, k, visits, pageviews, sketch FROM stats_daily"+f.sql(), f.args, func(r *sql.Rows) error {
		var day int64
		var dim, k string
		var visits, pageviews int
		var raw []byte
		if err := r.Scan(&day, &dim, &k, &visits, &pageviews, &raw); err != nil {
			return err
		}
		sketch, err := hll.Unmarshal(raw, sketchPrecision(dim))
		if err != nil {
			return nil // an unreadable sketch counts nobody rather than failing the page
		}
		if dim == dimReturning {
			returning.Merge(sketch)
			return nil
		}
		if dim == dimAll {
			total.Merge(sketch)
			if i, ok := index[day]; ok {
				t.Days[i].Visitors, t.Days[i].Visits, t.Days[i].Pageviews = sketch.Count(), visits, pageviews
			}
			return nil
		}
		if s := byKey[[2]string{dim, k}]; s != nil {
			s.sketch.Merge(sketch)
		}
		return nil
	})
	if err != nil {
		return t, fmt.Errorf("traffic sketches: %w", err)
	}

	if all := rows[dimAll]; len(all) > 0 {
		t.Totals = totalsOf(all[0], total, returning)
	}
	if t.Previous, err = d.dailyTotals(ctx, q.ProjectID, (q.PrevFrom+q.DayOffsetMs)/store.DayMs, from-1); err != nil {
		return t, err
	}
	for _, b := range []struct {
		dst *[]store.Breakdown
		at  int
	}{{&t.Sources, 0}, {&t.Channels, 1}, {&t.Campaigns, 2}, {&t.EntryPages, 3}, {&t.ExitPages, 4},
		{&t.Countries, 5}, {&t.Devices, 6}, {&t.Browsers, 7}, {&t.Systems, 8}, {&t.Languages, 9}} {
		dim := visitDims[b.at]
		out := []store.Breakdown{}
		for _, s := range rows[dim.dim] {
			row := store.Breakdown{Name: named(s.k, dim.empty), Visitors: s.sketch.Count(), Visits: s.visits}
			if dim.dim == dimExit {
				// A visit leaves from one page; a visitor counted on a page
				// they later moved on from is taken back here.
				row.Visits, row.Visitors = s.exits, min(row.Visitors, s.exits)
			}
			if row.Visits > 0 {
				out = append(out, row)
			}
		}
		slices.SortFunc(out, func(a, b store.Breakdown) int {
			return cmp.Or(cmp.Compare(b.Visitors, a.Visitors), cmp.Compare(b.Visits, a.Visits), strings.Compare(a.Name, b.Name))
		})
		*b.dst = out[:min(len(out), 10)]
	}

	exits := map[string]int{}
	for _, s := range rows[dimExit] {
		exits[s.k] = s.exits
	}
	pages := rows[dimPage]
	slices.SortFunc(pages, func(a, b *statRow) int {
		return cmp.Or(cmp.Compare(b.pageviews, a.pageviews), strings.Compare(a.k, b.k))
	})
	var missing []string
	for _, s := range pages {
		if s.pageviews == 0 {
			continue
		}
		p := store.PageMetric{Path: s.k, Views: s.pageviews, Visitors: s.sketch.Count(), AvgTimeMs: s.timeMs / int64(s.pageviews)}
		if s.scrollN > 0 {
			p.Scroll = int((s.scrollSum + int64(s.scrollN)/2) / int64(s.scrollN))
		}
		if n, ok := exits[s.k]; ok {
			p.Exits = n
		} else {
			missing = append(missing, s.k)
		}
		t.Pages = append(t.Pages, p)
	}
	if len(missing) > 0 { // a top page that is not among the top exit pages
		f := &filter{}
		f.add("project_id = ? AND day >= ? AND day <= ? AND dim = ?", q.ProjectID, from, to, dimExit)
		f.in("k", missing)
		err = d.each(ctx, "SELECT k, CAST(SUM(exits) AS BIGINT) FROM stats_daily"+f.sql()+" GROUP BY k", f.args, func(r *sql.Rows) error {
			var k string
			var n int
			if err := r.Scan(&k, &n); err != nil {
				return err
			}
			for i := range t.Pages {
				if t.Pages[i].Path == k {
					t.Pages[i].Exits = n
				}
			}
			return nil
		})
		if err != nil {
			return t, fmt.Errorf("traffic exits: %w", err)
		}
	}
	return t, nil
}

// totalsOf turns the sums of the "all" rows and the two sketches into the
// headline numbers. Someone on their first visit ever is new; someone who
// came again is returning, and within one window can be both.
func totalsOf(s *statRow, visitors, returning *hll.Sketch) store.TrafficTotals {
	t := store.TrafficTotals{Visitors: visitors.Count(), Visits: s.visits, Pageviews: s.pageviews, Bounces: max(s.bounces, 0)}
	if s.visits > 0 {
		t.AvgDurationMs = s.durationMs / int64(s.visits)
	}
	t.NewVisitors = min(s.newVisitors, t.Visitors)
	t.Returning = min(returning.Count(), t.Visitors)
	return t
}

// dailyTotals are the headline numbers of a range of days.
func (d *DB) dailyTotals(ctx context.Context, projectID string, from, to int64) (store.TrafficTotals, error) {
	var s statRow
	visitors, returning := hll.New(sketchPrecision(dimAll)), hll.New(sketchPrecision(dimReturning))
	err := d.each(ctx, `SELECT dim, visits, pageviews, bounces, duration_ms, new_visitors, sketch FROM stats_daily
		WHERE project_id = ? AND day >= ? AND day <= ? AND dim IN (?, ?) AND k = ''`, []any{projectID, from, to, dimAll, dimReturning}, func(r *sql.Rows) error {
		var dim string
		var visits, pageviews, bounces, fresh int
		var duration int64
		var raw []byte
		if err := r.Scan(&dim, &visits, &pageviews, &bounces, &duration, &fresh, &raw); err != nil {
			return err
		}
		sketch, err := hll.Unmarshal(raw, sketchPrecision(dim))
		if err != nil {
			return nil
		}
		if dim == dimReturning {
			returning.Merge(sketch)
			return nil
		}
		s.visits, s.pageviews, s.bounces, s.newVisitors, s.durationMs = s.visits+visits, s.pageviews+pageviews, s.bounces+bounces, s.newVisitors+fresh, s.durationMs+duration
		visitors.Merge(sketch)
		return nil
	})
	if err != nil {
		return store.TrafficTotals{}, fmt.Errorf("traffic totals: %w", err)
	}
	return totalsOf(&s, visitors, returning), nil
}

// Goals reads event goals and goals on one exact page from the daily
// tables. A goal on every page under a prefix has to look at the visits:
// one that viewed two such pages converts once.
func (d *DB) Goals(ctx context.Context, q store.AnalyticsQuery, goals []store.Step) ([]int, error) {
	if !unfiltered(q) {
		return d.goalsRaw(ctx, q, goals)
	}
	out := make([]int, len(goals))
	from, to := days(q)
	var slow []int
	for i, g := range goals {
		var err error
		switch {
		case g.Kind == "event":
			err = d.r.row(ctx, `SELECT CAST(COALESCE(SUM(visits), 0) AS BIGINT) FROM events_daily
				WHERE project_id = ? AND day >= ? AND day <= ? AND kind = ? AND name = ? AND path = ''`, q.ProjectID, from, to, store.KindTrack, g.Value).Scan(&out[i])
		case !strings.HasSuffix(g.Value, "*"):
			err = d.r.row(ctx, `SELECT CAST(COALESCE(SUM(visits), 0) AS BIGINT) FROM stats_daily
				WHERE project_id = ? AND day >= ? AND day <= ? AND dim = ? AND k = ?`, q.ProjectID, from, to, dimPage, g.Value).Scan(&out[i])
		default:
			slow = append(slow, i)
		}
		if err != nil {
			return out, fmt.Errorf("goals: %w", err)
		}
	}
	if len(slow) > 0 {
		steps := make([]store.Step, len(slow))
		for n, i := range slow {
			steps[n] = goals[i]
		}
		counts, err := d.goalsRaw(ctx, q, steps)
		if err != nil {
			return out, err
		}
		for n, i := range slow {
			out[i] = counts[n]
		}
	}
	return out, nil
}

func (d *DB) EventNames(ctx context.Context, q store.AnalyticsQuery) ([]store.EventStat, error) {
	if !unfiltered(q) {
		return d.eventNamesRaw(ctx, q)
	}
	out := []store.EventStat{}
	from, to := days(q)
	err := d.each(ctx, `SELECT name, CAST(SUM(n) AS BIGINT), CAST(SUM(visits) AS BIGINT), COALESCE(SUM(value), 0) FROM events_daily
		WHERE project_id = ? AND day >= ? AND day <= ? AND kind = ? AND path = ''
		GROUP BY name ORDER BY SUM(n) DESC, name LIMIT 100`, []any{q.ProjectID, from, to, store.KindTrack}, func(r *sql.Rows) error {
		var e store.EventStat
		if err := r.Scan(&e.Name, &e.Count, &e.Visits, &e.Value); err != nil {
			return err
		}
		out = append(out, e)
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("event names: %w", err)
	}
	return out, nil
}

// dailyEvent is one row of events_daily.
type dailyEvent struct {
	kind, name, path        string
	n, visits, num          int
	value                   float64
	aux                     int64
	firstTs, lastTs         int64
	label, props, lastVisit string
}

// dailyEvents reads the rows of some kinds in the window, optionally of
// some names only.
func (d *DB) dailyEvents(ctx context.Context, q store.AnalyticsQuery, kinds, names []string, fn func(e dailyEvent)) error {
	from, to := days(q)
	f := &filter{}
	f.add("project_id = ? AND day >= ? AND day <= ?", q.ProjectID, from, to)
	f.in("kind", kinds)
	if names != nil {
		f.in("name", names)
	}
	return d.each(ctx, "SELECT kind, name, path, n, visits, value, aux, num, first_ts, last_ts, label, props, last_visit FROM events_daily"+f.sql(), f.args,
		func(r *sql.Rows) error {
			var e dailyEvent
			if err := r.Scan(&e.kind, &e.name, &e.path, &e.n, &e.visits, &e.value, &e.aux, &e.num, &e.firstTs, &e.lastTs, &e.label, &e.props, &e.lastVisit); err != nil {
				return err
			}
			fn(e)
			return nil
		})
}

func (d *DB) ErrorGroups(ctx context.Context, q store.AnalyticsQuery) ([]store.ErrorGroup, error) {
	if !unfiltered(q) {
		return d.errorGroupsRaw(ctx, q)
	}
	groups, err := d.dailyErrorGroups(ctx, q, nil)
	if err != nil {
		return nil, fmt.Errorf("error groups: %w", err)
	}
	return groups, nil
}

func (d *DB) dailyErrorGroups(ctx context.Context, q store.AnalyticsQuery, only *string) ([]store.ErrorGroup, error) {
	from, to := days(q)
	f := &filter{}
	f.add("project_id = ? AND day >= ? AND day <= ? AND kind = ? AND name <> ''", q.ProjectID, from, to, store.KindError)
	if only != nil {
		f.add("name = ?", *only)
	}
	out := []store.ErrorGroup{}
	index := map[string]int{}
	var names []string
	err := d.each(ctx, "SELECT name, CAST(SUM(n) AS BIGINT), CAST(SUM(visits) AS BIGINT), MAX(last_ts) FROM events_daily"+f.sql()+
		" GROUP BY name ORDER BY SUM(visits) DESC, SUM(n) DESC, name LIMIT 100", f.args, func(r *sql.Rows) error {
		var g store.ErrorGroup
		if err := r.Scan(&g.Fingerprint, &g.Count, &g.Visits, &g.LastSeen); err != nil {
			return err
		}
		index[g.Fingerprint] = len(out)
		names = append(names, g.Fingerprint)
		out = append(out, g)
		return nil
	})
	if err != nil || len(out) == 0 {
		return out, err
	}
	// The latest message and stack, and the page each happens on most.
	latest := make([]int64, len(out))
	perPath := make([]map[string]int, len(out))
	err = d.dailyEvents(ctx, q, []string{store.KindError}, names, func(e dailyEvent) {
		i := index[e.name]
		if e.lastTs >= latest[i] && e.label != "" {
			latest[i], out[i].Message, out[i].Source = e.lastTs, e.label, propsSource(e.props)
		}
		if perPath[i] == nil {
			perPath[i] = map[string]int{}
		}
		perPath[i][e.path] += e.n
	})
	if err != nil {
		return out, err
	}
	for i, paths := range perPath {
		top := 0
		for path, n := range paths {
			if n > top || (n == top && path < out[i].Path) {
				top, out[i].Path = n, path
			}
		}
	}
	args := append([]any{q.ProjectID, store.KindError}, inArgs(names)...)
	err = d.each(ctx, "SELECT name, MIN(first_ts) FROM events_daily WHERE project_id = ? AND kind = ? AND first_ts > 0 AND name IN ("+
		placeholders(len(names))+") GROUP BY name", args, func(r *sql.Rows) error {
		var name string
		var ts int64
		if err := r.Scan(&name, &ts); err != nil {
			return err
		}
		out[index[name]].FirstSeen = ts
		return nil
	})
	return out, err
}

func (d *DB) Friction(ctx context.Context, q store.AnalyticsQuery) (store.Friction, error) {
	if !unfiltered(q) {
		return d.frictionRaw(ctx, q)
	}
	out := store.Friction{Pages: []store.PageFriction{}, Elements: []store.ElementFriction{}}
	from, to := days(q)
	pages := map[string]*store.PageFriction{}
	err := d.each(ctx, `SELECT k, CAST(SUM(visits) AS BIGINT) FROM stats_daily WHERE project_id = ? AND day >= ? AND day <= ? AND dim = ?
		GROUP BY k ORDER BY SUM(pageviews) DESC, k LIMIT 20`, []any{q.ProjectID, from, to, dimPage}, func(r *sql.Rows) error {
		p := &store.PageFriction{}
		if err := r.Scan(&p.Path, &p.Visits); err != nil {
			return err
		}
		pages[p.Path] = p
		return nil
	})
	if err != nil {
		return out, fmt.Errorf("friction pages: %w", err)
	}
	type element struct {
		store.ElementFriction
	}
	elements := map[[3]string]*element{}
	err = d.dailyEvents(ctx, q, []string{store.KindRage, store.KindDead, store.KindError}, nil, func(e dailyEvent) {
		if e.name == "" { // the page's own row
			if p := pages[e.path]; p != nil {
				switch e.kind {
				case store.KindRage:
					p.Rage += e.visits
				case store.KindDead:
					p.Dead += e.visits
				default:
					p.Errors += e.visits
				}
			}
			return
		}
		if e.kind == store.KindError {
			return
		}
		key := [3]string{e.kind, e.path, e.name}
		el := elements[key]
		if el == nil {
			el = &element{store.ElementFriction{Kind: e.kind, Path: e.path, Selector: e.name}}
			elements[key] = el
		}
		el.Count += e.n
		el.Visits += e.visits
		if e.lastTs >= el.Ts {
			el.Ts, el.Label, el.VisitID = e.lastTs, e.label, e.lastVisit
		}
	})
	if err != nil {
		return out, fmt.Errorf("friction: %w", err)
	}
	for _, p := range pages {
		// A visit cannot be troubled on a page more often than it viewed it.
		p.Rage, p.Dead, p.Errors = min(p.Rage, p.Visits), min(p.Dead, p.Visits), min(p.Errors, p.Visits)
		if p.Rage+p.Dead+p.Errors > 0 {
			out.Pages = append(out.Pages, *p)
		}
	}
	slices.SortFunc(out.Pages, func(a, b store.PageFriction) int {
		return cmp.Or(cmp.Compare(b.Rage+b.Dead+b.Errors, a.Rage+a.Dead+a.Errors), cmp.Compare(b.Visits, a.Visits), strings.Compare(a.Path, b.Path))
	})
	for _, el := range elements {
		out.Elements = append(out.Elements, el.ElementFriction)
	}
	slices.SortFunc(out.Elements, func(a, b store.ElementFriction) int {
		return cmp.Or(cmp.Compare(b.Visits, a.Visits), cmp.Compare(b.Count, a.Count), strings.Compare(a.Kind, b.Kind),
			strings.Compare(a.Path, b.Path), strings.Compare(a.Selector, b.Selector))
	})
	out.Elements = out.Elements[:min(len(out.Elements), 50)]
	return out, nil
}

func (d *DB) Requests(ctx context.Context, q store.AnalyticsQuery) ([]store.RequestStat, error) {
	if !unfiltered(q) {
		return d.requestsRaw(ctx, q)
	}
	byName := map[string]*store.RequestStat{}
	sums := map[string]float64{}
	err := d.dailyEvents(ctx, q, []string{store.KindRequest}, nil, func(e dailyEvent) {
		r := byName[e.name]
		if r == nil {
			r = &store.RequestStat{Name: e.name}
			byName[e.name] = r
		}
		r.Count += e.n
		r.Failed += int(e.aux)
		r.Visits += e.visits
		sums[e.name] += e.value
		if e.lastTs >= r.LastSeen {
			r.LastSeen, r.Ts, r.VisitID = e.lastTs, e.lastTs, e.lastVisit
			if e.num != 0 {
				r.Status = e.num
			}
		}
	})
	if err != nil {
		return nil, fmt.Errorf("requests: %w", err)
	}
	out := make([]store.RequestStat, 0, len(byName))
	for name, r := range byName {
		if r.Count > 0 {
			r.AvgMs = int64(sums[name] / float64(r.Count))
		}
		if r.Failed == 0 {
			r.Status = 0
		}
		out = append(out, *r)
	}
	slices.SortFunc(out, func(a, b store.RequestStat) int {
		return cmp.Or(cmp.Compare(b.Failed, a.Failed), cmp.Compare(b.Count, a.Count), strings.Compare(a.Name, b.Name))
	})
	return out[:min(len(out), 50)], nil
}

// Vitals reads the 75th percentiles from counts per 10% step of each
// metric: the answer is the average of the step the percentile falls in,
// so it is right to within a few percent.
func (d *DB) Vitals(ctx context.Context, q store.AnalyticsQuery) ([]store.PageVitals, error) {
	if !unfiltered(q) {
		return d.vitalsRaw(ctx, q)
	}
	metrics := []string{"lcp", "inp", "cls", "fcp", "ttfb"}
	type step struct {
		n   int
		sum float64
	}
	type histogram map[int]step
	pages := map[string]*[5]histogram{}
	err := d.dailyEvents(ctx, q, []string{store.KindVital}, nil, func(e dailyEvent) {
		name, bucket, ok := strings.Cut(e.name, "|")
		m := slices.Index(metrics, name)
		b, err := strconv.Atoi(bucket)
		if !ok || m < 0 || err != nil {
			return
		}
		p := pages[e.path]
		if p == nil {
			p = &[5]histogram{}
			pages[e.path] = p
		}
		if p[m] == nil {
			p[m] = histogram{}
		}
		p[m][b] = step{p[m][b].n + e.n, p[m][b].sum + e.value}
	})
	if err != nil {
		return nil, fmt.Errorf("vitals: %w", err)
	}
	out := make([]store.PageVitals, 0, len(pages))
	for path, hists := range pages {
		v := store.PageVitals{Path: path}
		values := [5]float64{-1, -1, -1, -1, -1}
		for m, h := range hists {
			total := 0
			buckets := make([]int, 0, len(h))
			for b, st := range h {
				total += st.n
				buckets = append(buckets, b)
			}
			if total == 0 {
				continue
			}
			if m == 0 || total > v.Samples && hists[0] == nil {
				v.Samples = total
			}
			slices.Sort(buckets)
			rank, seen := (total*3+3)/4, 0 // the 75th of a hundred, rounded up
			for _, b := range buckets {
				if seen += h[b].n; seen >= rank {
					values[m] = h[b].sum / float64(h[b].n)
					break
				}
			}
		}
		v.LCP, v.INP, v.CLS, v.FCP, v.TTFB = values[0], values[1], values[2], values[3], values[4]
		out = append(out, v)
	}
	slices.SortFunc(out, func(a, b store.PageVitals) int {
		if (a.Path == "") != (b.Path == "") { // the whole site first
			if a.Path == "" {
				return -1
			}
			return 1
		}
		return cmp.Or(cmp.Compare(b.Samples, a.Samples), strings.Compare(a.Path, b.Path))
	})
	return out[:min(len(out), 21)], nil
}

func (d *DB) HeatmapPages(ctx context.Context, q store.AnalyticsQuery) ([]store.PathCount, error) {
	if !unfiltered(q) {
		return d.heatmapPagesRaw(ctx, q)
	}
	out := []store.PathCount{}
	from, to := days(q)
	err := d.each(ctx, `SELECT path, CAST(SUM(n) AS BIGINT) FROM events_daily WHERE project_id = ? AND day >= ? AND day <= ? AND kind = ? AND name = ''
		GROUP BY path ORDER BY SUM(n) DESC, path LIMIT 50`, []any{q.ProjectID, from, to, dailyClickPage}, func(r *sql.Rows) error {
		var p store.PathCount
		if err := r.Scan(&p.Path, &p.Count); err != nil {
			return err
		}
		out = append(out, p)
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("heatmap pages: %w", err)
	}
	return out, nil
}

func (d *DB) Heatmap(ctx context.Context, q store.HeatmapQuery) (store.Heatmap, error) {
	h := store.Heatmap{Cells: []store.HeatCell{}, Elements: []store.HeatElement{}}
	from, to := (q.From+q.DayOffsetMs)/store.DayMs, (q.To-1+q.DayOffsetMs)/store.DayMs
	devices := []string{"Desktop", "Tablet", "Mobile"}
	if q.Device != "" {
		devices = []string{q.Device}
	}
	f := &filter{}
	f.add("project_id = ? AND day >= ? AND day <= ? AND path = ?", q.ProjectID, from, to, q.Path)
	f.in("device", devices)
	if err := d.r.row(ctx, "SELECT CAST(COALESCE(SUM(n), 0) AS BIGINT) FROM heat_daily"+f.sql(), f.args...).Scan(&h.Clicks); err != nil {
		return h, fmt.Errorf("heatmap clicks: %w", err)
	}
	err := d.each(ctx, "SELECT x, y, CAST(SUM(n) AS BIGINT) FROM heat_daily"+f.sql()+" GROUP BY x, y ORDER BY SUM(n) DESC, x, y LIMIT 5000", f.args,
		func(r *sql.Rows) error {
			var c store.HeatCell
			if err := r.Scan(&c.X, &c.Y, &c.N); err != nil {
				return err
			}
			h.Cells = append(h.Cells, c)
			return nil
		})
	if err != nil {
		return h, fmt.Errorf("heatmap cells: %w", err)
	}

	clicks, scrolls := make([]string, len(devices)), make([]string, len(devices))
	for i, device := range devices {
		clicks[i], scrolls[i] = dailyClicks+device, dailyScroll+device
	}
	type element struct {
		store.HeatElement
		ts int64
	}
	elements := map[string]*element{}
	var height, width float64
	f = &filter{}
	f.add("project_id = ? AND day >= ? AND day <= ? AND path = ?", q.ProjectID, from, to, q.Path)
	f.in("kind", append(slices.Clone(clicks), scrolls...))
	err = d.each(ctx, "SELECT kind, name, n, value, aux, last_ts, label FROM events_daily"+f.sql(), f.args, func(r *sql.Rows) error {
		var kind, name, label string
		var n int
		var value float64
		var aux, ts int64
		if err := r.Scan(&kind, &name, &n, &value, &aux, &ts, &label); err != nil {
			return err
		}
		if strings.HasPrefix(kind, dailyScroll) {
			decile, _ := strconv.Atoi(name)
			h.Views += n
			for i := range min(max(decile, 0), 10) {
				h.Scroll[i] += n
			}
			height, width = height+value, width+float64(aux)
			return nil
		}
		el := elements[name]
		if el == nil {
			el = &element{HeatElement: store.HeatElement{Selector: name}}
			elements[name] = el
		}
		el.Count += n
		if ts >= el.ts {
			el.ts, el.Label = ts, label
		}
		return nil
	})
	if err != nil {
		return h, fmt.Errorf("heatmap elements: %w", err)
	}
	for _, el := range elements {
		h.Elements = append(h.Elements, el.HeatElement)
	}
	slices.SortFunc(h.Elements, func(a, b store.HeatElement) int {
		return cmp.Or(cmp.Compare(b.Count, a.Count), strings.Compare(a.Selector, b.Selector))
	})
	h.Elements = h.Elements[:min(len(h.Elements), 30)]
	if h.Views > 0 { // the average page: its height and the width it was seen at
		h.Height, h.Width = int(height/float64(h.Views)), int(width/float64(h.Views))
	}
	if h.Width == 0 {
		h.Width = map[string]int{"Mobile": 390, "Tablet": 820}[q.Device]
		if h.Width == 0 {
			h.Width = 1280
		}
	}
	if h.Snapshot, err = d.heatSnapshot(ctx, q); err != nil {
		return h, err
	}
	return h, nil
}
