package sqlstore

import (
	"cmp"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"math"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/dimmihq/kimmi/internal/store"
)

// scanCap bounds the reports that are worked out in Go.
const scanCap = 200_000

// each runs a query and calls fn for every row.
func (d *DB) each(ctx context.Context, q string, args []any, fn func(rows *sql.Rows) error) error {
	rows, err := d.r.query(ctx, q, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		if err := fn(rows); err != nil {
			return err
		}
	}
	return rows.Err()
}

// visitConds adds a VisitFilter's conditions on a visits row aliased v.
func visitConds(f *filter, vf store.VisitFilter) {
	if vf.Path != "" {
		f.add("EXISTS (SELECT 1 FROM events pe WHERE pe.visit_id = v.id AND pe.kind = 'page' AND pe.path = ?)", vf.Path)
	}
	if vf.Referrer == "Direct" {
		f.add("v.referrer = ''")
		vf.Referrer = ""
	}
	for _, c := range []struct{ col, val string }{
		{"entry_path", vf.Entry}, {"exit_path", vf.Exit}, {"referrer", vf.Referrer}, {"channel", vf.Channel},
		{"utm_source", vf.UTMSource}, {"utm_campaign", vf.UTMCampaign}, {"country_code", vf.Country},
		{"device", vf.Device}, {"browser", vf.Browser}, {"os", vf.OS}, {"language", vf.Language},
	} {
		if c.val != "" {
			f.add("v."+c.col+" = ?", c.val)
		}
	}
}

// visitScope selects the visits (alias v) that started in from..to and
// pass the filter.
func visitScope(projectID string, from, to int64, vf store.VisitFilter) *filter {
	f := &filter{}
	f.add("v.project_id = ?", projectID)
	f.add("v.started_at >= ? AND v.started_at < ?", from, to)
	visitConds(f, vf)
	return f
}

// eventScope selects the window's events (alias e). They are joined to their
// visits (alias v) when the query filters visits or the caller reads them.
func eventScope(q store.AnalyticsQuery, visits bool) (string, *filter) {
	from := " FROM events e"
	f := &filter{}
	f.add("e.project_id = ?", q.ProjectID)
	f.add("e.ts >= ? AND e.ts < ?", q.From, q.To)
	if visits || q.Filter != (store.VisitFilter{}) {
		from += " JOIN visits v ON v.id = e.visit_id AND v.project_id = e.project_id"
		visitConds(f, q.Filter)
	}
	return from, f
}

func (f *filter) in(col string, values []string) {
	f.add(col+" IN ("+placeholders(len(values))+")", inArgs(values)...)
}

// named replaces an empty breakdown value.
func named(name, empty string) string {
	if name == "" {
		return empty
	}
	return name
}

// together runs the parts of one report side by side, a few at a time: each
// is its own query, and the page waits for the slowest instead of the sum.
func (d *DB) together(parts ...func() error) error {
	limit := 3 // SQLite reads on a few connections
	if d.pg() {
		limit = 6
	}
	slots := make(chan struct{}, limit)
	errs := make(chan error, len(parts))
	for _, part := range parts {
		slots <- struct{}{}
		go func() {
			defer func() { <-slots }()
			errs <- part()
		}()
	}
	var first error
	for range parts {
		if err := <-errs; err != nil && first == nil {
			first = err
		}
	}
	return first
}

func (d *DB) trafficRaw(ctx context.Context, q store.AnalyticsQuery) (store.Traffic, error) {
	t := store.Traffic{Days: []store.TrafficDay{}, Pages: []store.PageMetric{}}
	first, last := (q.From+q.DayOffsetMs)/store.DayMs, (q.To-1+q.DayOffsetMs)/store.DayMs
	index := map[int64]int{}
	for i := first; i <= last; i++ {
		index[i] = len(t.Days)
		t.Days = append(t.Days, store.TrafficDay{Date: dayLabel(i)})
	}
	parts := []func() error{
		func() (err error) {
			if t.Totals, err = d.trafficTotals(ctx, q, q.From, q.To); err != nil {
				err = fmt.Errorf("traffic totals: %w", err)
			}
			return err
		},
		func() (err error) {
			if t.Previous, err = d.trafficTotals(ctx, q, q.PrevFrom, q.From); err != nil {
				err = fmt.Errorf("traffic totals: %w", err)
			}
			return err
		},
		func() error {
			f := visitScope(q.ProjectID, q.From, q.To, q.Filter)
			err := d.each(ctx, `SELECT (v.started_at + ?) / 86400000 AS d, COUNT(DISTINCT v.visitor_key), COUNT(*), COALESCE(SUM(v.pageviews), 0)
				FROM visits v`+f.sql()+` GROUP BY d`, append([]any{q.DayOffsetMs}, f.args...), func(rows *sql.Rows) error {
				var day int64
				var td store.TrafficDay
				if err := rows.Scan(&day, &td.Visitors, &td.Visits, &td.Pageviews); err != nil {
					return err
				}
				if i, ok := index[day]; ok {
					td.Date = t.Days[i].Date
					t.Days[i] = td
				}
				return nil
			})
			if err != nil {
				return fmt.Errorf("traffic days: %w", err)
			}
			return nil
		},
		func() (err error) {
			if t.Pages, err = d.trafficPages(ctx, q); err != nil {
				err = fmt.Errorf("traffic pages: %w", err)
			}
			return err
		},
	}
	for _, b := range []struct {
		dst        *[]store.Breakdown
		col, empty string
	}{
		{&t.Sources, "referrer", "Direct"}, {&t.Channels, "channel", "Unknown"}, {&t.Campaigns, "utm_campaign", "None"},
		{&t.EntryPages, "entry_path", "Unknown"}, {&t.ExitPages, "exit_path", "Unknown"}, {&t.Countries, "country_code", "Unknown"},
		{&t.Devices, "device", "Unknown"}, {&t.Browsers, "browser", "Unknown"}, {&t.Systems, "os", "Unknown"},
		{&t.Languages, "language", "Unknown"},
	} {
		*b.dst = []store.Breakdown{}
		parts = append(parts, func() error {
			f := visitScope(q.ProjectID, q.From, q.To, q.Filter)
			col := "v." + b.col
			if b.col == "entry_path" || b.col == "exit_path" {
				f.add(col + " <> ''") // a visit without a page view entered and left nowhere
			}
			err := d.each(ctx, "SELECT "+col+", COUNT(DISTINCT v.visitor_key), COUNT(*) FROM visits v"+f.sql()+
				" GROUP BY "+col+" ORDER BY COUNT(DISTINCT v.visitor_key) DESC, COUNT(*) DESC, "+col+" LIMIT 10", f.args, func(rows *sql.Rows) error {
				var row store.Breakdown
				if err := rows.Scan(&row.Name, &row.Visitors, &row.Visits); err != nil {
					return err
				}
				row.Name = named(row.Name, b.empty)
				*b.dst = append(*b.dst, row)
				return nil
			})
			if err != nil {
				return fmt.Errorf("traffic %s: %w", b.col, err)
			}
			return nil
		})
	}
	return t, d.together(parts...)
}

func (d *DB) trafficTotals(ctx context.Context, q store.AnalyticsQuery, from, to int64) (store.TrafficTotals, error) {
	var t store.TrafficTotals
	f := visitScope(q.ProjectID, from, to, q.Filter)
	err := d.r.row(ctx, `SELECT COUNT(DISTINCT v.visitor_key), COUNT(*), COALESCE(SUM(v.pageviews), 0),
			COALESCE(SUM(CASE WHEN v.pageviews <= 1 AND v.actions = 0 AND v.engaged_ms < 10000 THEN 1 ELSE 0 END), 0),
			CAST(COALESCE(AVG(v.last_at - v.started_at), 0) AS BIGINT),
			COUNT(DISTINCT CASE WHEN NOT v.is_returning THEN v.visitor_key END),
			COUNT(DISTINCT CASE WHEN v.is_returning THEN v.visitor_key END)
		FROM visits v`+f.sql(), f.args...).
		Scan(&t.Visitors, &t.Visits, &t.Pageviews, &t.Bounces, &t.AvgDurationMs, &t.NewVisitors, &t.Returning)
	return t, err
}

func (d *DB) trafficPages(ctx context.Context, q store.AnalyticsQuery) ([]store.PageMetric, error) {
	out := []store.PageMetric{}
	index := map[string]int{}
	var paths []string
	from, f := eventScope(q, true)
	f.add("e.kind = ?", store.KindPage)
	err := d.each(ctx, "SELECT e.path, COUNT(*), COUNT(DISTINCT v.visitor_key)"+from+f.sql()+
		" GROUP BY e.path ORDER BY COUNT(*) DESC, e.path LIMIT 20", f.args, func(rows *sql.Rows) error {
		var p store.PageMetric
		if err := rows.Scan(&p.Path, &p.Views, &p.Visitors); err != nil {
			return err
		}
		index[p.Path] = len(out)
		paths = append(paths, p.Path)
		out = append(out, p)
		return nil
	})
	if err != nil || len(out) == 0 {
		return out, err
	}

	// A page can be left several times in one visit: its time adds up and
	// its scroll depth is the deepest of them.
	from, f = eventScope(q, false)
	f.add("e.kind = ?", store.KindLeave)
	f.in("e.path", paths)
	err = d.each(ctx, `SELECT t.path, CAST(SUM(t.ms) AS BIGINT), CAST(AVG(t.depth) AS DOUBLE PRECISION)
		FROM (SELECT e.path AS path, SUM(e.value) AS ms, MAX(e.num) AS depth`+from+f.sql()+` GROUP BY e.path, e.visit_id) t
		GROUP BY t.path`, f.args, func(rows *sql.Rows) error {
		var path string
		var ms int64
		var depth float64
		if err := rows.Scan(&path, &ms, &depth); err != nil {
			return err
		}
		p := &out[index[path]]
		p.AvgTimeMs, p.Scroll = ms/int64(p.Views), int(math.Round(depth))
		return nil
	})
	if err != nil {
		return out, err
	}

	f = visitScope(q.ProjectID, q.From, q.To, q.Filter)
	f.in("v.exit_path", paths)
	err = d.each(ctx, "SELECT v.exit_path, COUNT(*) FROM visits v"+f.sql()+" GROUP BY v.exit_path", f.args, func(rows *sql.Rows) error {
		var path string
		var n int
		if err := rows.Scan(&path, &n); err != nil {
			return err
		}
		out[index[path]].Exits = n
		return nil
	})
	return out, err
}

// stepCond matches the events (alias e) of one goal or funnel step.
func stepCond(s store.Step) (string, []any) {
	switch s.Kind {
	case "page":
		if prefix, ok := strings.CutSuffix(s.Value, "*"); ok {
			return "(e.kind = 'page' AND SUBSTR(e.path, 1, ?) = ?)", []any{utf8.RuneCountInString(prefix), prefix}
		}
		return "(e.kind = 'page' AND e.path = ?)", []any{s.Value}
	case "event":
		return "(e.kind = 'track' AND e.name = ?)", []any{s.Value}
	}
	return "(1 = 0)", nil
}

// stepMatches is stepCond for an event already read.
func stepMatches(s store.Step, kind, path, name string) bool {
	switch s.Kind {
	case "page":
		if kind != store.KindPage {
			return false
		}
		if prefix, ok := strings.CutSuffix(s.Value, "*"); ok {
			return strings.HasPrefix(path, prefix)
		}
		return path == s.Value
	case "event":
		return kind == store.KindTrack && name == s.Value
	}
	return false
}

func (d *DB) goalsRaw(ctx context.Context, q store.AnalyticsQuery, goals []store.Step) ([]int, error) {
	out := make([]int, len(goals))
	parts := make([]func() error, len(goals))
	for i, g := range goals {
		parts[i] = func() error {
			from, f := eventScope(q, false)
			cond, args := stepCond(g)
			f.add(cond, args...)
			if err := d.r.row(ctx, "SELECT COUNT(DISTINCT e.visit_id)"+from+f.sql(), f.args...).Scan(&out[i]); err != nil {
				return fmt.Errorf("goals: %w", err)
			}
			return nil
		}
	}
	return out, d.together(parts...)
}

func (d *DB) GoalSources(ctx context.Context, q store.AnalyticsQuery, goal store.Step) ([]store.NameCount, error) {
	from, f := eventScope(q, true)
	cond, args := stepCond(goal)
	f.add(cond, args...)
	out, err := d.nameCounts(ctx, "SELECT v.referrer, COUNT(DISTINCT e.visit_id)"+from+f.sql()+
		" GROUP BY v.referrer ORDER BY COUNT(DISTINCT e.visit_id) DESC, v.referrer LIMIT 10", f.args...)
	if err != nil {
		return nil, fmt.Errorf("goal sources: %w", err)
	}
	for i := range out {
		out[i].Name = named(out[i].Name, "Direct")
	}
	return out, nil
}

func (d *DB) eventNamesRaw(ctx context.Context, q store.AnalyticsQuery) ([]store.EventStat, error) {
	out := []store.EventStat{}
	from, f := eventScope(q, false)
	f.add("e.kind = ?", store.KindTrack)
	err := d.each(ctx, "SELECT e.name, COUNT(*), COUNT(DISTINCT e.visit_id), COALESCE(SUM(e.value), 0)"+from+f.sql()+
		" GROUP BY e.name ORDER BY COUNT(*) DESC, e.name LIMIT 100", f.args, func(rows *sql.Rows) error {
		var e store.EventStat
		if err := rows.Scan(&e.Name, &e.Count, &e.Visits, &e.Value); err != nil {
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

// latestEvent is the newest event of a group.
type latestEvent struct {
	kind, path, name, label, props, visitID string
	ts                                      int64
}

// latestEvents calls fn with the newest event of every group (partition is
// a list of e columns) among the events that from and f select.
func (d *DB) latestEvents(ctx context.Context, from string, f *filter, partition string, fn func(latestEvent)) error {
	return d.each(ctx, `SELECT t.kind, t.path, t.name, t.label, t.props, t.visit_id, t.ts FROM (
			SELECT e.kind, e.path, e.name, e.label, e.props, e.visit_id, e.ts,
				ROW_NUMBER() OVER (PARTITION BY `+partition+` ORDER BY e.ts DESC, e.id DESC) AS rn`+from+f.sql()+`
		) t WHERE t.rn = 1`, f.args, func(rows *sql.Rows) error {
		var e latestEvent
		if err := rows.Scan(&e.kind, &e.path, &e.name, &e.label, &e.props, &e.visitID, &e.ts); err != nil {
			return err
		}
		fn(e)
		return nil
	})
}

// propsSource reads the "source" key of an error's props.
func propsSource(props string) string {
	var p struct {
		Source string `json:"source"`
	}
	if json.Unmarshal([]byte(props), &p) != nil {
		return ""
	}
	return p.Source
}

func (d *DB) errorGroupsRaw(ctx context.Context, q store.AnalyticsQuery) ([]store.ErrorGroup, error) {
	out, err := d.errorGroups(ctx, q, nil)
	if err != nil {
		return nil, fmt.Errorf("error groups: %w", err)
	}
	return out, nil
}

// errorGroups lists the window's error groups, or only the one named.
func (d *DB) errorGroups(ctx context.Context, q store.AnalyticsQuery, only *string) ([]store.ErrorGroup, error) {
	scope := func() (string, *filter) {
		from, f := eventScope(q, false)
		f.add("e.kind = ?", store.KindError)
		if only != nil {
			f.add("e.name = ?", *only)
		}
		return from, f
	}
	out := []store.ErrorGroup{}
	index := map[string]int{}
	var names []string
	from, f := scope()
	err := d.each(ctx, "SELECT e.name, COUNT(*), COUNT(DISTINCT e.visit_id), MAX(e.ts)"+from+f.sql()+
		" GROUP BY e.name ORDER BY COUNT(DISTINCT e.visit_id) DESC, COUNT(*) DESC, e.name LIMIT 100", f.args, func(rows *sql.Rows) error {
		var g store.ErrorGroup
		if err := rows.Scan(&g.Fingerprint, &g.Count, &g.Visits, &g.LastSeen); err != nil {
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

	from, f = scope()
	f.in("e.name", names)
	err = d.latestEvents(ctx, from, f, "e.name", func(e latestEvent) {
		g := &out[index[e.name]]
		g.Message, g.Source = e.label, propsSource(e.props)
	})
	if err != nil {
		return out, err
	}

	from, f = scope()
	f.in("e.name", names)
	top := make([]int, len(out))
	err = d.each(ctx, "SELECT e.name, e.path, COUNT(*)"+from+f.sql()+" GROUP BY e.name, e.path", f.args, func(rows *sql.Rows) error {
		var name, path string
		var n int
		if err := rows.Scan(&name, &path, &n); err != nil {
			return err
		}
		i := index[name]
		if n > top[i] || (n == top[i] && path < out[i].Path) {
			top[i], out[i].Path = n, path
		}
		return nil
	})
	if err != nil {
		return out, err
	}

	args := append([]any{q.ProjectID, store.KindError}, inArgs(names)...)
	err = d.each(ctx, "SELECT name, MIN(ts) FROM events WHERE project_id = ? AND kind = ? AND name IN ("+placeholders(len(names))+") GROUP BY name",
		args, func(rows *sql.Rows) error {
			var name string
			var ts int64
			if err := rows.Scan(&name, &ts); err != nil {
				return err
			}
			out[index[name]].FirstSeen = ts
			return nil
		})
	return out, err
}

func (d *DB) ErrorGroup(ctx context.Context, q store.AnalyticsQuery, fingerprint string) (store.ErrorGroup, []store.Occurrence, error) {
	groups, err := d.dailyErrorGroups(ctx, q, &fingerprint)
	if err != nil {
		return store.ErrorGroup{}, nil, fmt.Errorf("error group: %w", err)
	}
	if len(groups) == 0 {
		return store.ErrorGroup{}, nil, fmt.Errorf("error group: %w", store.ErrNotFound)
	}
	occurrences := []store.Occurrence{}
	from, f := eventScope(q, true)
	f.add("e.kind = ?", store.KindError)
	f.add("e.name = ?", fingerprint)
	err = d.each(ctx, `SELECT e.visit_id, e.ts, e.path, e.label, e.props, v.browser, v.os, v.release, s.id IS NOT NULL, COALESCE(s.started_at, 0)`+
		from+` LEFT JOIN sessions s ON s.id = e.visit_id AND s.deleted_at IS NULL`+f.sql()+
		` ORDER BY e.ts DESC, e.id DESC LIMIT 50`, f.args, func(rows *sql.Rows) error {
		var o store.Occurrence
		if err := rows.Scan(&o.VisitID, &o.Ts, &o.Path, &o.Label, &o.Props, &o.Browser, &o.OS, &o.Release, &o.Recorded, &o.StartedAt); err != nil {
			return err
		}
		occurrences = append(occurrences, o)
		return nil
	})
	if err != nil {
		return store.ErrorGroup{}, nil, fmt.Errorf("error occurrences: %w", err)
	}
	return groups[0], occurrences, nil
}

func (d *DB) frictionRaw(ctx context.Context, q store.AnalyticsQuery) (store.Friction, error) {
	out := store.Friction{Pages: []store.PageFriction{}, Elements: []store.ElementFriction{}}

	var pages []store.PageFriction
	var paths []string
	index := map[string]int{}
	from, f := eventScope(q, false)
	f.add("e.kind = ?", store.KindPage)
	err := d.each(ctx, "SELECT e.path, COUNT(DISTINCT e.visit_id)"+from+f.sql()+
		" GROUP BY e.path ORDER BY COUNT(*) DESC, e.path LIMIT 20", f.args, func(rows *sql.Rows) error {
		var p store.PageFriction
		if err := rows.Scan(&p.Path, &p.Visits); err != nil {
			return err
		}
		index[p.Path] = len(pages)
		paths = append(paths, p.Path)
		pages = append(pages, p)
		return nil
	})
	if err != nil {
		return out, fmt.Errorf("friction pages: %w", err)
	}
	if len(pages) > 0 {
		from, f = eventScope(q, false)
		f.add("e.kind IN (?, ?, ?)", store.KindRage, store.KindDead, store.KindError)
		f.in("e.path", paths)
		err = d.each(ctx, "SELECT e.path, e.kind, COUNT(DISTINCT e.visit_id)"+from+f.sql()+" GROUP BY e.path, e.kind", f.args, func(rows *sql.Rows) error {
			var path, kind string
			var n int
			if err := rows.Scan(&path, &kind, &n); err != nil {
				return err
			}
			p := &pages[index[path]]
			switch kind {
			case store.KindRage:
				p.Rage = n
			case store.KindDead:
				p.Dead = n
			default:
				p.Errors = n
			}
			return nil
		})
		if err != nil {
			return out, fmt.Errorf("friction pages: %w", err)
		}
		for _, p := range pages {
			if p.Rage+p.Dead+p.Errors > 0 {
				out.Pages = append(out.Pages, p)
			}
		}
		slices.SortStableFunc(out.Pages, func(a, b store.PageFriction) int {
			return cmp.Or(cmp.Compare(b.Rage+b.Dead+b.Errors, a.Rage+a.Dead+a.Errors), cmp.Compare(b.Visits, a.Visits))
		})
	}

	type element struct{ kind, path, name string }
	elements := map[element]int{}
	scope := func() (string, *filter) {
		from, f := eventScope(q, false)
		f.add("e.kind IN (?, ?)", store.KindRage, store.KindDead)
		return from, f
	}
	from, f = scope()
	err = d.each(ctx, "SELECT e.kind, e.path, e.name, COUNT(*), COUNT(DISTINCT e.visit_id)"+from+f.sql()+
		" GROUP BY e.kind, e.path, e.name ORDER BY COUNT(DISTINCT e.visit_id) DESC, COUNT(*) DESC, e.kind, e.path, e.name LIMIT 50",
		f.args, func(rows *sql.Rows) error {
			var e store.ElementFriction
			if err := rows.Scan(&e.Kind, &e.Path, &e.Selector, &e.Count, &e.Visits); err != nil {
				return err
			}
			elements[element{e.Kind, e.Path, e.Selector}] = len(out.Elements)
			out.Elements = append(out.Elements, e)
			return nil
		})
	if err != nil {
		return out, fmt.Errorf("friction elements: %w", err)
	}
	if len(out.Elements) > 0 {
		from, f = scope()
		err = d.latestEvents(ctx, from, f, "e.kind, e.path, e.name", func(e latestEvent) {
			if i, ok := elements[element{e.kind, e.path, e.name}]; ok {
				el := &out.Elements[i]
				el.Label, el.VisitID, el.Ts = e.label, e.visitID, e.ts
			}
		})
		if err != nil {
			return out, fmt.Errorf("friction elements: %w", err)
		}
	}
	return out, nil
}

func (d *DB) requestsRaw(ctx context.Context, q store.AnalyticsQuery) ([]store.RequestStat, error) {
	const failed = "(e.num = 0 OR e.num >= 400)"
	scope := func() (string, *filter) {
		from, f := eventScope(q, false)
		f.add("e.kind = ?", store.KindRequest)
		return from, f
	}
	out := []store.RequestStat{}
	index := map[string]int{}
	var names []string
	from, f := scope()
	err := d.each(ctx, `SELECT e.name, COUNT(*), SUM(CASE WHEN `+failed+` THEN 1 ELSE 0 END), COUNT(DISTINCT e.visit_id),
			CAST(COALESCE(AVG(e.value), 0) AS BIGINT), MAX(e.ts)`+from+f.sql()+`
		GROUP BY e.name ORDER BY SUM(CASE WHEN `+failed+` THEN 1 ELSE 0 END) DESC, COUNT(*) DESC, e.name LIMIT 50`, f.args, func(rows *sql.Rows) error {
		var r store.RequestStat
		if err := rows.Scan(&r.Name, &r.Count, &r.Failed, &r.Visits, &r.AvgMs, &r.LastSeen); err != nil {
			return err
		}
		index[r.Name] = len(out)
		names = append(names, r.Name)
		out = append(out, r)
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("requests: %w", err)
	}
	if len(out) == 0 {
		return out, nil
	}

	from, f = scope()
	f.add(failed)
	f.in("e.name", names)
	top := make([]int, len(out))
	err = d.each(ctx, "SELECT e.name, e.num, COUNT(*)"+from+f.sql()+" GROUP BY e.name, e.num", f.args, func(rows *sql.Rows) error {
		var name string
		var status, n int
		if err := rows.Scan(&name, &status, &n); err != nil {
			return err
		}
		i := index[name]
		if n > top[i] || (n == top[i] && status < out[i].Status) {
			top[i], out[i].Status = n, status
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("request statuses: %w", err)
	}

	from, f = scope()
	f.in("e.name", names)
	err = d.latestEvents(ctx, from, f, "e.name", func(e latestEvent) {
		r := &out[index[e.name]]
		r.VisitID, r.Ts = e.visitID, e.ts
	})
	if err != nil {
		return nil, fmt.Errorf("latest requests: %w", err)
	}
	return out, nil
}

var vitalNames = []string{"lcp", "inp", "cls", "fcp", "ttfb"}

// vitalStats collects one page's sorted samples per metric.
type vitalStats struct {
	p75   [5]float64
	count [5]int
}

func newVitalStats() vitalStats { return vitalStats{p75: [5]float64{-1, -1, -1, -1, -1}} }

// set records a metric's samples, which must be sorted.
func (s *vitalStats) set(metric int, sorted []float64) {
	if len(sorted) == 0 {
		return
	}
	s.count[metric] = len(sorted)
	s.p75[metric] = sorted[(len(sorted)*3+3)/4-1] // nearest rank: ceil(0.75 n)
}

func (s vitalStats) page(path string) store.PageVitals {
	samples := s.count[0]
	if samples == 0 {
		samples = slices.Max(s.count[:])
	}
	return store.PageVitals{Path: path, Samples: samples, LCP: s.p75[0], INP: s.p75[1], CLS: s.p75[2], FCP: s.p75[3], TTFB: s.p75[4]}
}

// Vitals returns the whole site first (Path ""), then up to 20 pages with
// the most samples. Nothing comes back when nothing was measured.
func (d *DB) vitalsRaw(ctx context.Context, q store.AnalyticsQuery) ([]store.PageVitals, error) {
	from, f := eventScope(q, false)
	f.add("e.kind = ?", store.KindVital)
	f.in("e.name", vitalNames)

	var site [5][]float64
	pages := []store.PageVitals{}
	cur, curPath, curMetric := newVitalStats(), "", -1
	var values []float64
	rows := 0
	flushMetric := func() {
		if curMetric >= 0 {
			cur.set(curMetric, values)
		}
		values = values[:0]
	}
	flushPage := func() {
		flushMetric()
		if rows > 0 {
			pages = append(pages, cur.page(curPath))
		}
		cur = newVitalStats()
	}
	err := d.each(ctx, "SELECT e.path, e.name, e.value"+from+f.sql()+" ORDER BY e.path, e.name, e.value LIMIT ?", append(f.args, scanCap), func(r *sql.Rows) error {
		var path, name string
		var value float64
		if err := r.Scan(&path, &name, &value); err != nil {
			return err
		}
		metric := slices.Index(vitalNames, name)
		if rows == 0 || path != curPath {
			flushPage()
			curPath, curMetric = path, metric
		} else if metric != curMetric {
			flushMetric()
			curMetric = metric
		}
		rows++
		values = append(values, value)
		site[metric] = append(site[metric], value)
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("vitals: %w", err)
	}
	if rows == 0 {
		return pages, nil
	}
	flushPage()

	all := newVitalStats()
	for i := range site {
		slices.Sort(site[i])
		all.set(i, site[i])
	}
	slices.SortStableFunc(pages, func(a, b store.PageVitals) int {
		return cmp.Or(cmp.Compare(b.Samples, a.Samples), cmp.Compare(a.Path, b.Path))
	})
	if len(pages) > 20 {
		pages = pages[:20]
	}
	return append([]store.PageVitals{all.page("")}, pages...), nil
}

// Funnel streams the window's matching events visit by visit, newest visit
// first, and keeps only how far the current visit got.
func (d *DB) Funnel(ctx context.Context, q store.AnalyticsQuery, steps []store.Step) ([]store.FunnelStep, error) {
	out := make([]store.FunnelStep, len(steps))
	for i := range out {
		out[i].Dropped = []string{}
	}
	if len(steps) == 0 {
		return out, nil
	}
	from, f := eventScope(q, true)
	conds := make([]string, len(steps))
	var condArgs []any
	for i, s := range steps {
		cond, args := stepCond(s)
		conds[i] = cond
		condArgs = append(condArgs, args...)
	}
	f.add("("+strings.Join(conds, " OR ")+")", condArgs...)

	visit, reached := "", 0
	finish := func() {
		for i := range reached {
			out[i].Visits++
		}
		if reached > 0 && reached < len(steps) && len(out[reached-1].Dropped) < 200 {
			out[reached-1].Dropped = append(out[reached-1].Dropped, visit)
		}
	}
	err := d.each(ctx, "SELECT e.visit_id, e.kind, e.path, e.name"+from+f.sql()+
		" ORDER BY v.started_at DESC, e.visit_id, e.ts, e.id", f.args, func(rows *sql.Rows) error {
		var id, kind, path, name string
		if err := rows.Scan(&id, &kind, &path, &name); err != nil {
			return err
		}
		if id != visit {
			finish()
			visit, reached = id, 0
		}
		if reached < len(steps) && stepMatches(steps[reached], kind, path, name) {
			reached++
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("funnel: %w", err)
	}
	finish()
	return out, nil
}

func (d *DB) heatmapPagesRaw(ctx context.Context, q store.AnalyticsQuery) ([]store.PathCount, error) {
	out := []store.PathCount{}
	from, f := eventScope(q, false)
	f.add("e.kind = ?", store.KindClick)
	err := d.each(ctx, "SELECT e.path, COUNT(*)"+from+f.sql()+" GROUP BY e.path ORDER BY COUNT(*) DESC, e.path LIMIT 50", f.args, func(rows *sql.Rows) error {
		var p store.PathCount
		if err := rows.Scan(&p.Path, &p.Count); err != nil {
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

// deviceCond limits a viewport width column to a device class ("" for all).
func deviceCond(col, device string) string {
	switch device {
	case "Mobile":
		return col + " < 768"
	case "Tablet":
		return col + " >= 768 AND " + col + " < 1024"
	case "Desktop":
		return col + " >= 1024"
	}
	return ""
}

// heatScope selects one page's events (alias e) of a kind and device class.
func heatScope(q store.HeatmapQuery, kinds ...string) *filter {
	f := &filter{}
	f.add("e.project_id = ?", q.ProjectID)
	f.in("e.kind", kinds)
	f.add("e.ts >= ? AND e.ts < ?", q.From, q.To)
	f.add("e.path = ?", q.Path)
	if c := deviceCond("e.w", q.Device); c != "" {
		f.add(c)
	}
	return f
}

func median(values []int) int {
	if len(values) == 0 {
		return 0
	}
	slices.Sort(values)
	return values[len(values)/2]
}

func (d *DB) heatmapRaw(ctx context.Context, q store.HeatmapQuery) (store.Heatmap, error) {
	h := store.Heatmap{Cells: []store.HeatCell{}, Elements: []store.HeatElement{}}
	const from = " FROM events e"

	f := heatScope(q, store.KindClick)
	if err := d.r.row(ctx, "SELECT COUNT(*)"+from+f.sql(), f.args...).Scan(&h.Clicks); err != nil {
		return h, fmt.Errorf("heatmap clicks: %w", err)
	}
	err := d.each(ctx, `SELECT CASE WHEN e.x < 0 THEN 0 WHEN e.x >= 10000 THEN 99 ELSE e.x / 100 END AS cx,
			CASE WHEN e.y < 0 THEN 0 ELSE e.y / 10 END AS cy, COUNT(*)`+from+f.sql()+`
		GROUP BY cx, cy ORDER BY COUNT(*) DESC, cx, cy LIMIT 5000`, f.args, func(rows *sql.Rows) error {
		var c store.HeatCell
		if err := rows.Scan(&c.X, &c.Y, &c.N); err != nil {
			return err
		}
		h.Cells = append(h.Cells, c)
		return nil
	})
	if err != nil {
		return h, fmt.Errorf("heatmap cells: %w", err)
	}

	index := map[string]int{}
	var names []string
	err = d.each(ctx, "SELECT e.name, COUNT(*)"+from+f.sql()+" GROUP BY e.name ORDER BY COUNT(*) DESC, e.name LIMIT 30", f.args, func(rows *sql.Rows) error {
		var e store.HeatElement
		if err := rows.Scan(&e.Selector, &e.Count); err != nil {
			return err
		}
		index[e.Selector] = len(h.Elements)
		names = append(names, e.Selector)
		h.Elements = append(h.Elements, e)
		return nil
	})
	if err != nil {
		return h, fmt.Errorf("heatmap elements: %w", err)
	}
	if len(names) > 0 {
		f = heatScope(q, store.KindClick)
		f.in("e.name", names)
		err = d.latestEvents(ctx, from, f, "e.name", func(e latestEvent) { h.Elements[index[e.name]].Label = e.label })
		if err != nil {
			return h, fmt.Errorf("heatmap elements: %w", err)
		}
	}

	// Scroll depth counts a visit once, at the deepest it got on the page.
	f = heatScope(q, store.KindLeave)
	var reached strings.Builder
	dst := []any{&h.Views}
	for i := range h.Scroll {
		fmt.Fprintf(&reached, ", COALESCE(SUM(CASE WHEN t.depth >= %d THEN 1 ELSE 0 END), 0)", (i+1)*10)
		dst = append(dst, &h.Scroll[i])
	}
	err = d.r.row(ctx, "SELECT COUNT(*)"+reached.String()+" FROM (SELECT MAX(e.num) AS depth"+from+f.sql()+" GROUP BY e.visit_id) t", f.args...).Scan(dst...)
	if err != nil {
		return h, fmt.Errorf("heatmap scroll: %w", err)
	}

	sample := func(col string, f *filter) (int, error) {
		f.add(col + " > 0")
		var values []int
		err := d.each(ctx, "SELECT "+col+from+f.sql()+" ORDER BY e.ts DESC, e.id DESC LIMIT 2000", f.args, func(rows *sql.Rows) error {
			var v int
			if err := rows.Scan(&v); err != nil {
				return err
			}
			values = append(values, v)
			return nil
		})
		return median(values), err
	}
	if h.Height, err = sample("e.y", heatScope(q, store.KindLeave)); err != nil {
		return h, fmt.Errorf("heatmap height: %w", err)
	}
	if h.Width, err = sample("e.w", heatScope(q, store.KindClick, store.KindLeave)); err != nil {
		return h, fmt.Errorf("heatmap width: %w", err)
	}

	if h.Snapshot, err = d.heatSnapshot(ctx, q); err != nil {
		return h, err
	}
	return h, nil
}

// heatSnapshot finds the latest recording that shows the page at the
// device's width, to draw under a heatmap.
func (d *DB) heatSnapshot(ctx context.Context, q store.HeatmapQuery) (*store.HeatmapSource, error) {
	f := &filter{}
	f.add("e.project_id = ?", q.ProjectID)
	f.add("e.kind = ?", store.KindPage)
	f.add("e.ts >= ? AND e.ts < ?", q.From, q.To)
	f.add("e.path = ?", q.Path)
	if c := deviceCond("s.viewport_w", q.Device); c != "" {
		f.add(c)
	}
	var snap store.HeatmapSource
	err := d.r.row(ctx, `SELECT s.id, e.ts, s.started_at FROM events e
		JOIN sessions s ON s.id = e.visit_id AND s.project_id = e.project_id AND s.deleted_at IS NULL`+f.sql()+`
		ORDER BY e.ts DESC, e.id DESC LIMIT 1`, f.args...).Scan(&snap.RecordingID, &snap.Ts, &snap.StartedAt)
	switch {
	case err == nil:
		return &snap, nil
	case err != sql.ErrNoRows:
		return nil, fmt.Errorf("heatmap snapshot: %w", err)
	}
	return nil, nil
}

// Retention counts only visitors with an anonymous id: a cookieless hash
// changes every day, so it can never come back.
func (d *DB) retentionRaw(ctx context.Context, q store.RetentionQuery) (store.Retention, error) {
	r := store.Retention{Cohorts: []store.Cohort{}}
	const known = "project_id = ? AND visitor_key LIKE 'a:%'"
	err := d.r.row(ctx, `SELECT COUNT(DISTINCT CASE WHEN started_at >= ? THEN visitor_key END),
			COUNT(DISTINCT CASE WHEN started_at >= ? THEN visitor_key END), COUNT(DISTINCT visitor_key)
		FROM visits WHERE `+known+` AND started_at >= ? AND started_at <= ?`,
		q.Now-store.DayMs, q.Now-7*store.DayMs, q.ProjectID, q.Now-30*store.DayMs, q.Now).Scan(&r.Daily, &r.Weekly, &r.Monthly)
	if err != nil {
		return r, fmt.Errorf("retention totals: %w", err)
	}

	// Weeks are counted from Monday 1970-01-05 in the project's time.
	const weekMs = 7 * store.DayMs
	weeks := min(q.Weeks, 104)
	if weeks <= 0 {
		weeks = 8
	}
	shift := q.DayOffsetMs - 4*store.DayMs
	current := (q.Now + shift) / weekMs
	first := current - int64(weeks) + 1
	start := first*weekMs - shift
	for w := first; w <= current; w++ {
		r.Cohorts = append(r.Cohorts, store.Cohort{Week: dayLabel(w*7 + 4), Active: make([]int, current-w+1)})
	}

	cohort := map[string]int{}
	err = d.each(ctx, `SELECT visitor_key, MIN(started_at) FROM visits WHERE `+known+`
		GROUP BY visitor_key HAVING MIN(started_at) >= ? AND MIN(started_at) <= ?
		ORDER BY MIN(started_at) DESC LIMIT ?`, []any{q.ProjectID, start, q.Now, scanCap}, func(rows *sql.Rows) error {
		var key string
		var firstAt int64
		if err := rows.Scan(&key, &firstAt); err != nil {
			return err
		}
		i := int((firstAt+shift)/weekMs - first)
		cohort[key] = i
		r.Cohorts[i].Size++
		return nil
	})
	if err != nil {
		return r, fmt.Errorf("retention cohorts: %w", err)
	}
	if len(cohort) == 0 {
		return r, nil
	}
	err = d.each(ctx, `SELECT DISTINCT visitor_key, (started_at + ?) / 604800000 FROM visits
		WHERE `+known+` AND started_at >= ? AND started_at <= ?`, []any{shift, q.ProjectID, start, q.Now}, func(rows *sql.Rows) error {
		var key string
		var week int64
		if err := rows.Scan(&key, &week); err != nil {
			return err
		}
		if i, ok := cohort[key]; ok {
			if k := int(week-first) - i; k >= 0 && k < len(r.Cohorts[i].Active) {
				r.Cohorts[i].Active[k]++
			}
		}
		return nil
	})
	if err != nil {
		return r, fmt.Errorf("retention activity: %w", err)
	}
	return r, nil
}

func (d *DB) Releases(ctx context.Context, q store.AnalyticsQuery) ([]store.ReleaseStat, error) {
	out := []store.ReleaseStat{}
	err := d.each(ctx, `SELECT s.release, COUNT(*), SUM(CASE WHEN s.errors > 0 THEN 1 ELSE 0 END),
			SUM(CASE WHEN s.rage_clicks > 0 OR s.dead_clicks > 0 THEN 1 ELSE 0 END), MAX(s.last_at), f.first_seen
		FROM sessions s JOIN (
			SELECT release, MIN(started_at) AS first_seen FROM sessions
			WHERE project_id = ? AND deleted_at IS NULL AND release <> '' GROUP BY release
		) f ON f.release = s.release
		WHERE s.project_id = ? AND s.deleted_at IS NULL AND s.started_at >= ? AND s.started_at < ? AND s.release <> ''
		GROUP BY s.release, f.first_seen ORDER BY f.first_seen DESC, s.release LIMIT 20`,
		[]any{q.ProjectID, q.ProjectID, q.From, q.To}, func(rows *sql.Rows) error {
			var r store.ReleaseStat
			if err := rows.Scan(&r.Release, &r.Sessions, &r.Errors, &r.Friction, &r.LastSeen, &r.FirstSeen); err != nil {
				return err
			}
			out = append(out, r)
			return nil
		})
	if err != nil {
		return nil, fmt.Errorf("releases: %w", err)
	}
	return out, nil
}

// freeMail lists domains that say nothing about where someone works.
var freeMail = map[string]bool{
	"gmail.com": true, "googlemail.com": true, "yahoo.com": true, "hotmail.com": true, "outlook.com": true, "live.com": true,
	"icloud.com": true, "me.com": true, "proton.me": true, "protonmail.com": true, "aol.com": true, "gmx.com": true,
	"gmx.de": true, "mail.com": true, "yandex.com": true, "qq.com": true,
}

func (d *DB) Accounts(ctx context.Context, projectID string) ([]store.Account, error) {
	byDomain := map[string]*store.Account{}
	err := d.each(ctx, `SELECT email, sessions, last_seen FROM visitors WHERE project_id = ? AND email IS NOT NULL
		ORDER BY last_seen DESC LIMIT ?`, []any{projectID, scanCap}, func(rows *sql.Rows) error {
		var email string
		var sessions int
		var lastSeen int64
		if err := rows.Scan(&email, &sessions, &lastSeen); err != nil {
			return err
		}
		at := strings.LastIndexByte(email, '@')
		domain := strings.ToLower(strings.TrimSpace(email[at+1:]))
		if at < 0 || domain == "" || freeMail[domain] {
			return nil
		}
		a := byDomain[domain]
		if a == nil {
			a = &store.Account{Domain: domain}
			byDomain[domain] = a
		}
		a.People++
		a.Sessions += sessions
		a.LastSeen = max(a.LastSeen, lastSeen)
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("accounts: %w", err)
	}
	out := make([]store.Account, 0, len(byDomain))
	for _, a := range byDomain {
		out = append(out, *a)
	}
	slices.SortFunc(out, func(a, b store.Account) int {
		return cmp.Or(cmp.Compare(b.LastSeen, a.LastSeen), cmp.Compare(a.Domain, b.Domain))
	})
	if len(out) > 200 {
		out = out[:200]
	}
	return out, nil
}

func (d *DB) RecordingsByID(ctx context.Context, projectID string, ids []string) ([]store.Recording, error) {
	out := []store.Recording{}
	for part := range slices.Chunk(ids, rowsPerStatement) {
		args := append([]any{projectID}, inArgs(part)...)
		found, err := d.recordings(ctx, recordingSelect+" WHERE s.project_id = ? AND s.deleted_at IS NULL AND s.id IN ("+placeholders(len(part))+")", args...)
		if err != nil {
			return nil, fmt.Errorf("recordings by id: %w", err)
		}
		out = append(out, found...)
	}
	slices.SortFunc(out, func(a, b store.Recording) int {
		return cmp.Or(cmp.Compare(b.StartedAt, a.StartedAt), strings.Compare(b.ID, a.ID))
	})
	return out, nil
}
