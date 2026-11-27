package sqlstore

import (
	"cmp"
	"context"
	"database/sql"
	"fmt"
	"slices"
	"strconv"
	"strings"

	"github.com/dimmihq/kimmi/internal/settings"
	"github.com/dimmihq/kimmi/internal/store"
)

// Funnels and weekly cohorts, kept as visits come in (see rollup.go).
//
//	funnel_daily   per day, funnel and step: visits that reached it
//	funnel_visits  how far each visit got, to list who stopped where
//	known_visitors per lasting visitor: first week and the weeks seen
//	cohort_weekly  per first week and week: visitors active

type funnelKey struct {
	project string
	day     int64
	funnel  string
	step    int
}

// funnelVisit is how far one visit has got in one funnel.
type funnelVisit struct {
	project, funnel, visit string
	day                    int64
	step                   int
}

// knownVisit is a visit by someone with a lasting identity, in a week.
type knownVisit struct {
	project, visitor string
	week             int64
}

// weekOf is the week a day belongs to, counted from Monday 1970-01-05.
func weekOf(day int64) int64 { return (day - 4) / 7 }

// advance moves a visit through a funnel with the events of this flush:
// each event may take it one step further.
func (d *daily) advance(v *visitDelta, f store.Funnel, project string, day int64) {
	was := v.funnels[f.ID]
	reached := was
	for _, batch := range v.events {
		for _, e := range batch {
			if reached < len(f.Steps) && stepMatches(f.Steps[reached], e.Kind, e.Path, e.Name) {
				d.funnels[funnelKey{project, day, f.ID, reached}]++
				reached++
			}
		}
	}
	if reached > was {
		d.reached = append(d.reached, funnelVisit{project, f.ID, v.id, day, reached - 1})
	}
}

func applyFunnels(ctx context.Context, c conn, add *daily) error {
	keys := make([]funnelKey, 0, len(add.funnels))
	for k := range add.funnels {
		keys = append(keys, k)
	}
	slices.SortFunc(keys, func(a, b funnelKey) int {
		return cmp.Or(strings.Compare(a.project, b.project), cmp.Compare(a.day, b.day), strings.Compare(a.funnel, b.funnel), cmp.Compare(a.step, b.step))
	})
	for part := range slices.Chunk(keys, rowsPerStatement) {
		args := make([]any, 0, len(part)*5)
		for _, k := range part {
			args = append(args, k.project, k.day, k.funnel, k.step, add.funnels[k])
		}
		if _, err := c.exec(ctx, `INSERT INTO funnel_daily (project_id, day, funnel_id, step, visits) VALUES `+valueRows(len(part), 5)+`
			ON CONFLICT (project_id, day, funnel_id, step) DO UPDATE SET visits = funnel_daily.visits + excluded.visits`, args...); err != nil {
			return fmt.Errorf("upsert funnels: %w", err)
		}
	}
	// A visit can move twice in one flush: its last place wins.
	last := map[[2]string]funnelVisit{}
	for _, r := range add.reached {
		last[[2]string{r.visit, r.funnel}] = r
	}
	reached := make([]funnelVisit, 0, len(last))
	for _, r := range last {
		reached = append(reached, r)
	}
	slices.SortFunc(reached, func(a, b funnelVisit) int {
		return cmp.Or(strings.Compare(a.visit, b.visit), strings.Compare(a.funnel, b.funnel))
	})
	for part := range slices.Chunk(reached, rowsPerStatement) {
		args := make([]any, 0, len(part)*5)
		for _, r := range part {
			args = append(args, r.visit, r.funnel, r.project, r.day, r.step)
		}
		if _, err := c.exec(ctx, `INSERT INTO funnel_visits (visit_id, funnel_id, project_id, day, step) VALUES `+valueRows(len(part), 5)+`
			ON CONFLICT (visit_id, funnel_id) DO UPDATE SET step = excluded.step`, args...); err != nil {
			return fmt.Errorf("upsert funnel progress: %w", err)
		}
	}
	return nil
}

// weeksOf and weeksText read and write the weeks a visitor was seen in.
func weeksOf(text string) []int64 {
	var out []int64
	for _, part := range strings.Split(text, ",") {
		if w, err := strconv.ParseInt(part, 10, 64); err == nil {
			out = append(out, w)
		}
	}
	return out
}

func weeksText(weeks []int64) string {
	parts := make([]string, len(weeks))
	for i, w := range weeks {
		parts[i] = strconv.FormatInt(w, 10)
	}
	return strings.Join(parts, ",")
}

// applyCohorts keeps, for every visitor with a lasting identity, the week
// they were first seen and the weeks they came in, and from those the
// cohort table: how many of each first week were active in each week. The
// order visits arrive in does not matter: a visit older than a visitor's
// first moves them, with their weeks, to the earlier cohort.
func applyCohorts(ctx context.Context, c conn, known []knownVisit) error {
	if len(known) == 0 {
		return nil
	}
	type who struct{ project, visitor string }
	type state struct {
		first int64
		weeks []int64
	}
	visitors := map[who]*state{}
	var order []who
	for _, k := range known {
		w := who{k.project, k.visitor}
		if visitors[w] == nil {
			visitors[w] = &state{}
			order = append(order, w)
		}
	}
	slices.SortFunc(order, func(a, b who) int {
		return cmp.Or(strings.Compare(a.project, b.project), strings.Compare(a.visitor, b.visitor))
	})
	for part := range slices.Chunk(order, rowsPerStatement) {
		args := make([]any, 0, len(part)*2)
		for _, w := range part {
			args = append(args, w.project, w.visitor)
		}
		rows, err := c.query(ctx, "SELECT project_id, visitor_key, first_week, weeks FROM known_visitors WHERE (project_id, visitor_key) IN (VALUES "+
			valueRows(len(part), 2)+")", args...)
		if err != nil {
			return fmt.Errorf("load known visitors: %w", err)
		}
		for rows.Next() {
			var w who
			var st state
			var weeks string
			if err := rows.Scan(&w.project, &w.visitor, &st.first, &weeks); err != nil {
				rows.Close()
				return fmt.Errorf("load known visitors: %w", err)
			}
			st.weeks = weeksOf(weeks)
			*visitors[w] = st
		}
		if err := rows.Close(); err != nil {
			return fmt.Errorf("load known visitors: %w", err)
		}
	}

	type cell struct {
		project      string
		cohort, week int64
	}
	cells := map[cell]int{}
	changed := map[who]bool{}
	for _, k := range known {
		w := who{k.project, k.visitor}
		st := visitors[w]
		switch {
		case len(st.weeks) == 0:
			st.first, st.weeks = k.week, []int64{k.week}
			cells[cell{k.project, k.week, k.week}]++
		case slices.Contains(st.weeks, k.week):
			continue
		case k.week < st.first:
			for _, week := range st.weeks {
				cells[cell{k.project, st.first, week}]--
				cells[cell{k.project, k.week, week}]++
			}
			st.first = k.week
			st.weeks = append(st.weeks, k.week)
			cells[cell{k.project, k.week, k.week}]++
		default:
			st.weeks = append(st.weeks, k.week)
			cells[cell{k.project, st.first, k.week}]++
		}
		changed[w] = true
	}

	var rows []who
	for _, w := range order {
		if changed[w] {
			rows = append(rows, w)
		}
	}
	for part := range slices.Chunk(rows, rowsPerStatement) {
		args := make([]any, 0, len(part)*4)
		for _, w := range part {
			st := visitors[w]
			slices.Sort(st.weeks)
			if len(st.weeks) > 104 { // two years of weeks are plenty for a cohort table
				st.weeks = st.weeks[len(st.weeks)-104:]
			}
			args = append(args, w.project, w.visitor, st.first, weeksText(st.weeks))
		}
		if _, err := c.exec(ctx, `INSERT INTO known_visitors (project_id, visitor_key, first_week, weeks) VALUES `+valueRows(len(part), 4)+`
			ON CONFLICT (project_id, visitor_key) DO UPDATE SET first_week = excluded.first_week, weeks = excluded.weeks`, args...); err != nil {
			return fmt.Errorf("upsert known visitors: %w", err)
		}
	}
	keys := make([]cell, 0, len(cells))
	for k, n := range cells {
		if n != 0 {
			keys = append(keys, k)
		}
	}
	slices.SortFunc(keys, func(a, b cell) int {
		return cmp.Or(strings.Compare(a.project, b.project), cmp.Compare(a.cohort, b.cohort), cmp.Compare(a.week, b.week))
	})
	for part := range slices.Chunk(keys, rowsPerStatement) {
		args := make([]any, 0, len(part)*4)
		for _, k := range part {
			args = append(args, k.project, k.cohort, k.week, cells[k])
		}
		if _, err := c.exec(ctx, `INSERT INTO cohort_weekly (project_id, cohort, week, visitors) VALUES `+valueRows(len(part), 4)+`
			ON CONFLICT (project_id, cohort, week) DO UPDATE SET visitors = cohort_weekly.visitors + excluded.visitors`, args...); err != nil {
			return fmt.Errorf("upsert cohorts: %w", err)
		}
	}
	return nil
}

// forgetKnown takes one visitor out of the weekly cohorts.
func forgetKnown(ctx context.Context, c conn, projectID, visitorKey string) error {
	var first int64
	var weeks string
	err := c.row(ctx, "SELECT first_week, weeks FROM known_visitors WHERE project_id = ? AND visitor_key = ?", projectID, visitorKey).Scan(&first, &weeks)
	if err == sql.ErrNoRows {
		return nil
	}
	if err != nil {
		return err
	}
	for _, week := range weeksOf(weeks) {
		if _, err := c.exec(ctx, "UPDATE cohort_weekly SET visitors = visitors - 1 WHERE project_id = ? AND cohort = ? AND week = ?", projectID, first, week); err != nil {
			return err
		}
	}
	_, err = c.exec(ctx, "DELETE FROM known_visitors WHERE project_id = ? AND visitor_key = ?", projectID, visitorKey)
	return err
}

// projectFunnels reads the funnels a project has defined.
func projectFunnels(ctx context.Context, c conn, projectID string) ([]store.Funnel, error) {
	var raw string
	var days int
	var keep bool
	err := c.row(ctx, "SELECT settings, retention_days, keep_starred FROM projects WHERE id = ?", projectID).Scan(&raw, &days, &keep)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read funnels: %w", err)
	}
	var out []store.Funnel
	for _, f := range settings.Decode([]byte(raw), days, keep).Analytics.Funnels {
		steps := make([]store.Step, len(f.Steps))
		for i, st := range f.Steps {
			steps[i] = store.Step{Kind: st.Kind, Value: st.Value}
		}
		out = append(out, store.Funnel{ID: f.ID, Steps: steps})
	}
	return out, nil
}

// FunnelCounts reads a defined funnel from what was counted as visits
// came in: visits per step, and up to 200 of the latest that stopped at each.
func (d *DB) FunnelCounts(ctx context.Context, q store.AnalyticsQuery, funnelID string, steps int) ([]store.FunnelStep, error) {
	out := make([]store.FunnelStep, steps)
	for i := range out {
		out[i].Dropped = []string{}
	}
	from, to := days(q)
	err := d.each(ctx, `SELECT step, CAST(SUM(visits) AS BIGINT) FROM funnel_daily
		WHERE project_id = ? AND funnel_id = ? AND day >= ? AND day <= ? GROUP BY step`, []any{q.ProjectID, funnelID, from, to}, func(r *sql.Rows) error {
		var step, n int
		if err := r.Scan(&step, &n); err != nil {
			return err
		}
		if step >= 0 && step < steps {
			out[step].Visits = n
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("funnel: %w", err)
	}
	for i := 0; i+1 < steps; i++ {
		err := d.each(ctx, `SELECT visit_id FROM funnel_visits WHERE project_id = ? AND funnel_id = ? AND step = ? AND day >= ? AND day <= ?
			ORDER BY day DESC, visit_id DESC LIMIT 200`, []any{q.ProjectID, funnelID, i, from, to}, func(r *sql.Rows) error {
			var id string
			if err := r.Scan(&id); err != nil {
				return err
			}
			out[i].Dropped = append(out[i].Dropped, id)
			return nil
		})
		if err != nil {
			return nil, fmt.Errorf("funnel drop-offs: %w", err)
		}
	}
	return out, nil
}

// BackfillFunnel counts a funnel over the visits already stored, so a
// funnel defined today shows the past too. It reads the events on one
// connection and writes on another, a few hundred visits at a time.
func (d *DB) BackfillFunnel(ctx context.Context, projectID string, f store.Funnel) error {
	for _, table := range []string{"funnel_daily", "funnel_visits"} {
		if _, err := d.w.exec(ctx, "DELETE FROM "+table+" WHERE project_id = ? AND funnel_id = ?", projectID, f.ID); err != nil {
			return fmt.Errorf("backfill funnel: %w", err)
		}
	}
	if len(f.Steps) == 0 {
		return nil
	}
	add := &daily{funnels: map[funnelKey]int{}}
	flush := func() error {
		err := d.tx(ctx, func(c conn) error { return applyFunnels(ctx, c, add) })
		add = &daily{funnels: map[funnelKey]int{}}
		return err
	}
	conds := make([]string, len(f.Steps))
	args := []any{projectID}
	for i, s := range f.Steps {
		cond, a := stepCond(s)
		conds[i] = cond
		args = append(args, a...)
	}
	visit, reached := "", 0
	var day int64
	finish := func() {
		if reached > 0 {
			add.reached = append(add.reached, funnelVisit{projectID, f.ID, visit, day, reached - 1})
		}
	}
	err := d.each(ctx, `SELECT e.visit_id, v.day, e.kind, e.path, e.name FROM events e JOIN visits v ON v.id = e.visit_id
		WHERE e.project_id = ? AND (`+strings.Join(conds, " OR ")+`) ORDER BY e.visit_id, e.ts, e.id`, args, func(r *sql.Rows) error {
		var id, kind, path, name string
		var at int64
		if err := r.Scan(&id, &at, &kind, &path, &name); err != nil {
			return err
		}
		if id != visit {
			finish()
			visit, reached, day = id, 0, at
			if len(add.reached) >= rowsPerStatement {
				if err := flush(); err != nil {
					return err
				}
			}
		}
		if reached < len(f.Steps) && stepMatches(f.Steps[reached], kind, path, name) {
			add.funnels[funnelKey{projectID, day, f.ID, reached}]++
			reached++
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("backfill funnel: %w", err)
	}
	finish()
	if err := flush(); err != nil {
		return fmt.Errorf("backfill funnel: %w", err)
	}
	return nil
}

// Retention reads the people active lately from the daily sketches of
// visitors with a lasting identity, and the cohorts from their table.
func (d *DB) Retention(ctx context.Context, q store.RetentionQuery) (store.Retention, error) {
	r := store.Retention{Cohorts: []store.Cohort{}}
	today := (q.Now + q.DayOffsetMs) / store.DayMs
	month := newKnownSketch()
	week, dayOnly := newKnownSketch(), newKnownSketch()
	err := d.each(ctx, "SELECT day, sketch FROM stats_daily WHERE project_id = ? AND dim = ? AND k = '' AND day > ? AND day <= ?",
		[]any{q.ProjectID, dimKnown, today - 30, today}, func(rows *sql.Rows) error {
			var day int64
			var raw []byte
			if err := rows.Scan(&day, &raw); err != nil {
				return err
			}
			s, err := unmarshalKnown(raw)
			if err != nil {
				return nil
			}
			month.Merge(s)
			if day > today-7 {
				week.Merge(s)
			}
			if day == today {
				dayOnly.Merge(s)
			}
			return nil
		})
	if err != nil {
		return r, fmt.Errorf("retention totals: %w", err)
	}
	r.Daily, r.Weekly, r.Monthly = dayOnly.Count(), week.Count(), month.Count()

	weeks := min(q.Weeks, 104)
	if weeks <= 0 {
		weeks = 8
	}
	current := weekOf(today)
	first := current - int64(weeks) + 1
	for w := first; w <= current; w++ {
		r.Cohorts = append(r.Cohorts, store.Cohort{Week: dayLabel(w*7 + 4), Active: make([]int, current-w+1)})
	}
	err = d.each(ctx, "SELECT cohort, week, visitors FROM cohort_weekly WHERE project_id = ? AND cohort >= ? AND cohort <= ?",
		[]any{q.ProjectID, first, current}, func(rows *sql.Rows) error {
			var cohort, at int64
			var n int
			if err := rows.Scan(&cohort, &at, &n); err != nil {
				return err
			}
			c := &r.Cohorts[cohort-first]
			if k := int(at - cohort); k >= 0 && k < len(c.Active) {
				c.Active[k] = max(n, 0)
				if k == 0 {
					c.Size = max(n, 0)
				}
			}
			return nil
		})
	if err != nil {
		return r, fmt.Errorf("retention cohorts: %w", err)
	}
	return r, nil
}
