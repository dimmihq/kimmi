package sqlstore

import (
	"cmp"
	"context"
	"fmt"
	"math"
	"slices"
	"strconv"
	"strings"

	"github.com/dimmihq/kimmi/internal/hll"
	"github.com/dimmihq/kimmi/internal/store"
)

// The daily tables are what the analytics pages read. Every flush adds to
// them in the transaction that stores its visits and events, so a page
// reads a few rows per day and breakdown value whatever the traffic was.
//
//	stats_daily   per day, dimension and value: visits, page views, bounces,
//	              time, and a sketch of the distinct visitors
//	events_daily  per day, kind, name and path: how often, in how many
//	              visits, and the latest occurrence
//	heat_daily    per day, page, device class and grid cell: clicks
//
// A day is the project's own day, by the visit's start.

// Dimensions of stats_daily.
const (
	dimAll      = "all"
	dimSource   = "source"
	dimChannel  = "channel"
	dimCampaign = "campaign"
	dimEntry    = "entry"
	dimExit     = "exit"
	dimCountry  = "country"
	dimDevice   = "device"
	dimBrowser  = "browser"
	dimOS       = "os"
	dimLanguage = "language"
	dimPage     = "page"
	// dimReturning has one row a day: the visits by someone seen before,
	// and who made them.
	dimReturning = "returning"
)

// sketchPrecision is how exact a row's distinct count is once it holds more
// visitors than are kept one by one: 0.8% for the totals (up to 2,048 exact),
// 3.3% for a breakdown row (up to 128 exact).
func sketchPrecision(dim string) uint8 {
	if dim == dimAll || dim == dimReturning {
		return 14
	}
	return 10
}

// Kinds of events_daily beyond the event kinds themselves.
const (
	dailyClickPage = "click"   // clicks per page, for the list of pages with a heatmap
	dailyClicks    = "click:"  // + device class: clicks per element
	dailyScroll    = "scroll:" // + device class: page views per deepest-scroll decile (name "0".."10")
)

type statKey struct {
	project string
	day     int64
	dim, k  string
}

type statDelta struct {
	visits, pageviews, bounces, newVisitors, scrollN, exits int
	durationMs, timeMs, scrollSum                           int64
	hashes                                                  []uint64
}

type eventKey struct {
	project          string
	day              int64
	kind, name, path string
}

type eventDelta struct {
	n, visits, num  int
	value           float64
	aux             int64
	firstTs, lastTs int64
	label, props    string
	lastVisit       string
}

type heatKey struct {
	project      string
	day          int64
	path, device string
	x, y         int
}

type daily struct {
	stats  map[statKey]*statDelta
	events map[eventKey]*eventDelta
	heat   map[heatKey]int
}

func (d *daily) stat(k statKey) *statDelta {
	s := d.stats[k]
	if s == nil {
		s = &statDelta{}
		d.stats[k] = s
	}
	return s
}

func (d *daily) event(k eventKey) *eventDelta {
	e := d.events[k]
	if e == nil {
		e = &eventDelta{}
		d.events[k] = e
	}
	return e
}

func isBounce(pageviews, actions int, engaged int64) bool {
	return pageviews <= 1 && actions == 0 && engaged < 10_000
}

// deviceClass names the heatmap a viewport width belongs to.
func deviceClass(w int) string {
	switch {
	case w < 768:
		return "Mobile"
	case w < 1024:
		return "Tablet"
	}
	return "Desktop"
}

// vitalBucket puts a web vital on a scale of 10% steps, so a percentile can
// be read from counts: bucket b holds values around vitalValue(b).
func vitalBucket(name string, v float64) int {
	if name == "cls" {
		v *= 1000
	}
	if v < 1 {
		return 0
	}
	return 1 + int(math.Log(v)/math.Log(1.1))
}

// countedSet is what a visit has already been counted for in the "visits"
// columns of the daily tables: 8 hex digits per thing. It keeps a visit that
// sends several hits from being counted twice.
type countedSet struct {
	text    string
	changed bool
}

const countedMax = 96

// first reports whether the visit is seen doing this for the first time,
// and remembers it. Past countedMax things it answers no: an eventful
// visit is then counted a little short rather than several times.
func (c *countedSet) first(kind, name, path string) bool {
	h := strconv.FormatUint(hll.Hash(kind+"\x00"+name+"\x00"+path)>>32, 16)
	h = strings.Repeat("0", 8-len(h)) + h
	for i := 0; i+8 <= len(c.text); i += 8 {
		if c.text[i:i+8] == h {
			return false
		}
	}
	if len(c.text) >= countedMax*8 {
		return false
	}
	c.text += h
	c.changed = true
	return true
}

// rollUp works out what a flush adds to the daily tables, and sets each
// visit's counted set.
func rollUp(deltas []*visitDelta) *daily {
	d := &daily{stats: map[statKey]*statDelta{}, events: map[eventKey]*eventDelta{}, heat: map[heatKey]int{}}
	for _, v := range deltas {
		h := v.first
		project := h.ProjectID
		isNew := v.prev == nil
		// What does not change once a visit exists comes from its row.
		started, visitor := v.startedAt, h.VisitorKey
		attrs := [...][2]string{{dimAll, ""}, {dimSource, h.Referrer}, {dimChannel, h.Channel}, {dimCampaign, h.UTMCampaign},
			{dimCountry, h.CountryCode}, {dimDevice, h.Device}, {dimBrowser, h.Browser}, {dimOS, h.OS}, {dimLanguage, h.Language}}
		var before visitRow
		if !isNew {
			before = *v.prev
			started, visitor = before.startedAt, before.visitorKey
			attrs = [...][2]string{{dimAll, ""}, {dimSource, before.referrer}, {dimChannel, before.channel}, {dimCampaign, before.campaign},
				{dimCountry, before.country}, {dimDevice, before.device}, {dimBrowser, before.browser}, {dimOS, before.os}, {dimLanguage, before.language}}
		}
		day := (started + h.DayOffsetMs) / store.DayMs
		if !isNew {
			day = before.day // the day it was first counted on, whatever the time zone is now
		}
		v.day = day
		hash := hll.Hash(visitor)
		counted := countedSet{text: before.counted}

		pageviews, actions, engaged := before.pageviews+v.pageviews, before.actions+v.actions, before.engaged+v.engaged
		lastAt := max(before.lastAt, v.lastAt)
		bounces, duration := 0, lastAt-started
		if isBounce(pageviews, actions, engaged) {
			bounces = 1
		}
		if !isNew {
			duration -= before.lastAt - started
			if isBounce(before.pageviews, before.actions, before.engaged) {
				bounces--
			}
		}
		for _, a := range attrs {
			s := d.stat(statKey{project, day, a[0], a[1]})
			s.pageviews += v.pageviews
			s.bounces += bounces
			s.durationMs += duration
			if isNew {
				s.visits++
				s.hashes = append(s.hashes, hash)
				if !v.returning {
					s.newVisitors++
				}
			}
		}
		if isNew && v.returning {
			s := d.stat(statKey{project, day, dimReturning, ""})
			s.visits++
			s.hashes = append(s.hashes, hash)
		}
		// The entry page is known with the first page view, the exit page
		// moves with every later one.
		if before.entry == "" && v.entry != "" {
			s := d.stat(statKey{project, day, dimEntry, v.entry})
			s.visits++
			s.hashes = append(s.hashes, hash)
		}
		if v.exit != "" && v.exit != before.exit {
			if before.exit != "" {
				d.stat(statKey{project, day, dimExit, before.exit}).exits--
			}
			s := d.stat(statKey{project, day, dimExit, v.exit})
			s.exits++
			s.hashes = append(s.hashes, hash)
		}

		for _, batch := range v.events {
			for _, e := range batch {
				switch e.Kind {
				case store.KindPage:
					s := d.stat(statKey{project, day, dimPage, e.Path})
					s.pageviews++
					s.hashes = append(s.hashes, hash)
					if counted.first(e.Kind, "", e.Path) {
						s.visits++
					}
				case store.KindLeave:
					s := d.stat(statKey{project, day, dimPage, e.Path})
					s.timeMs += int64(e.Value)
					s.scrollSum += int64(e.Num)
					s.scrollN++
					if e.Y > 0 {
						r := d.event(eventKey{project, day, dailyScroll + deviceClass(e.W), strconv.Itoa(min(max(e.Num, 0), 100) / 10), e.Path})
						r.n++
						r.value += float64(e.Y)
						r.aux += int64(e.W)
					}
				case store.KindTrack:
					r := d.event(eventKey{project, day, e.Kind, e.Name, ""})
					r.n++
					r.value += e.Value
					r.lastTs = max(r.lastTs, e.Ts)
					if counted.first(e.Kind, e.Name, "") {
						r.visits++
					}
				case store.KindError, store.KindRage, store.KindDead:
					r := d.event(eventKey{project, day, e.Kind, e.Name, e.Path})
					r.n++
					// An error is one group on every page, so a visit counts once
					// for it; a clicked element belongs to its page.
					once := e.Path
					if e.Kind == store.KindError {
						once = "\x00group"
					}
					if counted.first(e.Kind, e.Name, once) {
						r.visits++
					}
					if r.firstTs == 0 || e.Ts < r.firstTs {
						r.firstTs = e.Ts
					}
					if e.Ts >= r.lastTs {
						r.lastTs, r.label, r.props, r.lastVisit = e.Ts, e.Label, e.Props, v.id
					}
					// The page's own row: visits troubled there, whatever by.
					if counted.first(e.Kind, "", e.Path) {
						d.event(eventKey{project, day, e.Kind, "", e.Path}).visits++
					}
				case store.KindRequest:
					r := d.event(eventKey{project, day, e.Kind, e.Name, ""})
					r.n++
					r.value += e.Value
					if e.Num == 0 || e.Num >= 400 {
						r.aux++
						r.num = e.Num
					}
					if counted.first(e.Kind, e.Name, "") {
						r.visits++
					}
					if e.Ts >= r.lastTs {
						r.lastTs, r.lastVisit = e.Ts, v.id
					}
				case store.KindVital:
					// Counted per 10% step, with the sum, so a percentile reads
					// as the average of the step it falls in.
					name := e.Name + "|" + strconv.Itoa(vitalBucket(e.Name, e.Value))
					for _, path := range []string{e.Path, ""} {
						r := d.event(eventKey{project, day, e.Kind, name, path})
						r.n++
						r.value += e.Value
					}
				case store.KindClick:
					device := deviceClass(e.W)
					d.heat[heatKey{project, day, e.Path, device, min(max(e.X/100, 0), 99), max(e.Y, 0) / 10}]++
					d.event(eventKey{project, day, dailyClickPage, "", e.Path}).n++
					r := d.event(eventKey{project, day, dailyClicks + device, e.Name, e.Path})
					r.n++
					if e.Ts >= r.lastTs {
						r.lastTs, r.label = e.Ts, e.Label
					}
				}
			}
		}
		v.counted = counted.text
	}
	return d
}

// applyDaily adds a flush's deltas to the daily tables.
func (d *DB) applyDaily(ctx context.Context, c conn, add *daily) error {
	// Two nodes adding to the same day's sketches would lose one side's
	// visitors: on PostgreSQL they take turns per project and day. (SQLite
	// has one writer.) Taken in order, so two flushes never wait on each other.
	if d.pg() {
		type scope struct {
			project string
			day     int64
		}
		seen := map[scope]bool{}
		var scopes []scope
		for k := range add.stats {
			if s := (scope{k.project, k.day}); !seen[s] {
				seen[s] = true
				scopes = append(scopes, s)
			}
		}
		slices.SortFunc(scopes, func(a, b scope) int { return cmp.Or(strings.Compare(a.project, b.project), cmp.Compare(a.day, b.day)) })
		for _, s := range scopes {
			if _, err := c.exec(ctx, "SELECT pg_advisory_xact_lock(hashtext(?))", s.project+" "+strconv.FormatInt(s.day, 10)); err != nil {
				return fmt.Errorf("lock day: %w", err)
			}
		}
	}
	if err := d.applyStats(ctx, c, add.stats); err != nil {
		return err
	}
	if err := d.applyEventsDaily(ctx, c, add.events); err != nil {
		return err
	}
	return applyHeat(ctx, c, add.heat)
}

func (d *DB) applyStats(ctx context.Context, c conn, stats map[statKey]*statDelta) error {
	keys := make([]statKey, 0, len(stats))
	for k := range stats {
		keys = append(keys, k)
	}
	slices.SortFunc(keys, func(a, b statKey) int {
		return cmp.Or(strings.Compare(a.project, b.project), cmp.Compare(a.day, b.day), strings.Compare(a.dim, b.dim), strings.Compare(a.k, b.k))
	})

	// The sketches that get new visitors are read, added to and written back.
	sketches := map[statKey][]byte{}
	type group struct {
		project string
		day     int64
		dim     string
	}
	wanted := map[group][]string{}
	var groups []group
	for _, k := range keys {
		if len(stats[k].hashes) == 0 {
			continue
		}
		g := group{k.project, k.day, k.dim}
		if _, ok := wanted[g]; !ok {
			groups = append(groups, g)
		}
		wanted[g] = append(wanted[g], k.k)
	}
	existing := map[statKey]*hll.Sketch{}
	for _, g := range groups {
		for part := range slices.Chunk(wanted[g], rowsPerStatement) {
			rows, err := c.query(ctx, "SELECT k, sketch FROM stats_daily WHERE project_id = ? AND day = ? AND dim = ? AND k IN ("+placeholders(len(part))+")",
				append([]any{g.project, g.day, g.dim}, inArgs(part)...)...)
			if err != nil {
				return fmt.Errorf("load sketches: %w", err)
			}
			for rows.Next() {
				var k string
				var raw []byte
				if err := rows.Scan(&k, &raw); err != nil {
					rows.Close()
					return fmt.Errorf("load sketches: %w", err)
				}
				if s, err := hll.Unmarshal(raw, sketchPrecision(g.dim)); err == nil {
					existing[statKey{g.project, g.day, g.dim, k}] = s
				}
			}
			if err := rows.Close(); err != nil {
				return fmt.Errorf("load sketches: %w", err)
			}
		}
	}
	for _, k := range keys {
		if len(stats[k].hashes) == 0 {
			continue
		}
		s := existing[k]
		if s == nil {
			s = hll.New(sketchPrecision(k.dim))
		}
		for _, h := range stats[k].hashes {
			s.Add(h)
		}
		sketches[k] = s.Marshal()
	}

	const cols = 14
	for part := range slices.Chunk(keys, rowsPerStatement) {
		args := make([]any, 0, len(part)*cols)
		for _, k := range part {
			s := stats[k]
			sketch := sketches[k]
			if sketch == nil {
				sketch = []byte{} // no new visitor: the row keeps its sketch
			}
			args = append(args, k.project, k.day, k.dim, k.k, s.visits, s.pageviews, s.bounces, s.durationMs, s.newVisitors,
				s.timeMs, s.scrollSum, s.scrollN, s.exits, sketch)
		}
		_, err := c.exec(ctx, `INSERT INTO stats_daily (project_id, day, dim, k, visits, pageviews, bounces, duration_ms, new_visitors,
				time_ms, scroll_sum, scroll_n, exits, sketch)
			VALUES `+valueRows(len(part), cols)+`
			ON CONFLICT (project_id, day, dim, k) DO UPDATE SET
				visits = stats_daily.visits + excluded.visits,
				pageviews = stats_daily.pageviews + excluded.pageviews,
				bounces = stats_daily.bounces + excluded.bounces,
				duration_ms = stats_daily.duration_ms + excluded.duration_ms,
				new_visitors = stats_daily.new_visitors + excluded.new_visitors,
				time_ms = stats_daily.time_ms + excluded.time_ms,
				scroll_sum = stats_daily.scroll_sum + excluded.scroll_sum,
				scroll_n = stats_daily.scroll_n + excluded.scroll_n,
				exits = stats_daily.exits + excluded.exits,
				sketch = CASE WHEN LENGTH(excluded.sketch) > 0 THEN excluded.sketch ELSE stats_daily.sketch END`, args...)
		if err != nil {
			return fmt.Errorf("upsert stats: %w", err)
		}
	}
	return nil
}

func (d *DB) applyEventsDaily(ctx context.Context, c conn, events map[eventKey]*eventDelta) error {
	keys := make([]eventKey, 0, len(events))
	for k := range events {
		keys = append(keys, k)
	}
	slices.SortFunc(keys, func(a, b eventKey) int {
		return cmp.Or(strings.Compare(a.project, b.project), cmp.Compare(a.day, b.day), strings.Compare(a.kind, b.kind),
			strings.Compare(a.name, b.name), strings.Compare(a.path, b.path))
	})
	g := d.greatest()
	const cols = 15
	for part := range slices.Chunk(keys, rowsPerStatement) {
		args := make([]any, 0, len(part)*cols)
		for _, k := range part {
			e := events[k]
			args = append(args, k.project, k.day, k.kind, k.name, k.path, e.n, e.visits, e.value, e.aux, e.num, e.firstTs, e.lastTs, e.label, e.props, e.lastVisit)
		}
		// The latest occurrence wins the label, the stack and the visit to watch.
		newer := "excluded.last_ts >= events_daily.last_ts"
		_, err := c.exec(ctx, `INSERT INTO events_daily (project_id, day, kind, name, path, n, visits, value, aux, num, first_ts, last_ts, label, props, last_visit)
			VALUES `+valueRows(len(part), cols)+`
			ON CONFLICT (project_id, day, kind, name, path) DO UPDATE SET
				n = events_daily.n + excluded.n,
				visits = events_daily.visits + excluded.visits,
				value = events_daily.value + excluded.value,
				aux = events_daily.aux + excluded.aux,
				num = CASE WHEN excluded.num <> 0 THEN excluded.num ELSE events_daily.num END,
				first_ts = CASE WHEN events_daily.first_ts = 0 OR (excluded.first_ts > 0 AND excluded.first_ts < events_daily.first_ts)
					THEN excluded.first_ts ELSE events_daily.first_ts END,
				label = CASE WHEN `+newer+` AND excluded.label <> '' THEN excluded.label ELSE events_daily.label END,
				props = CASE WHEN `+newer+` AND excluded.props <> '' THEN excluded.props ELSE events_daily.props END,
				last_visit = CASE WHEN `+newer+` AND excluded.last_visit <> '' THEN excluded.last_visit ELSE events_daily.last_visit END,
				last_ts = `+g+`(events_daily.last_ts, excluded.last_ts)`, args...)
		if err != nil {
			return fmt.Errorf("upsert daily events: %w", err)
		}
	}
	return nil
}

func applyHeat(ctx context.Context, c conn, heat map[heatKey]int) error {
	keys := make([]heatKey, 0, len(heat))
	for k := range heat {
		keys = append(keys, k)
	}
	slices.SortFunc(keys, func(a, b heatKey) int {
		return cmp.Or(strings.Compare(a.project, b.project), cmp.Compare(a.day, b.day), strings.Compare(a.path, b.path),
			strings.Compare(a.device, b.device), cmp.Compare(a.x, b.x), cmp.Compare(a.y, b.y))
	})
	const cols = 7
	for part := range slices.Chunk(keys, rowsPerStatement) {
		args := make([]any, 0, len(part)*cols)
		for _, k := range part {
			args = append(args, k.project, k.day, k.path, k.device, k.x, k.y, heat[k])
		}
		_, err := c.exec(ctx, `INSERT INTO heat_daily (project_id, day, path, device, x, y, n) VALUES `+valueRows(len(part), cols)+`
			ON CONFLICT (project_id, day, path, device, x, y) DO UPDATE SET n = heat_daily.n + excluded.n`, args...)
		if err != nil {
			return fmt.Errorf("upsert heat: %w", err)
		}
	}
	return nil
}

// rebuildDaily counts some days of a project again from its visits and
// events: after a visitor was erased, the sums must no longer include them.
// It reads a day's visits a few hundred at a time.
func (d *DB) rebuildDaily(ctx context.Context, c conn, projectID string, days []int64) error {
	for _, day := range days {
		for _, table := range []string{"stats_daily", "events_daily", "heat_daily"} {
			if _, err := c.exec(ctx, "DELETE FROM "+table+" WHERE project_id = ? AND day = ?", projectID, day); err != nil {
				return fmt.Errorf("rebuild day: %w", err)
			}
		}
		after := ""
		for {
			rows, err := c.query(ctx, `SELECT id, org_id, visitor_key, started_at, last_at, pageviews, actions, engaged_ms, entry_path, exit_path,
					referrer, channel, utm_campaign, country_code, device, browser, os, language, is_returning
				FROM visits WHERE project_id = ? AND day = ? AND id > ? ORDER BY id LIMIT ?`, projectID, day, after, rowsPerStatement)
			if err != nil {
				return fmt.Errorf("rebuild day: %w", err)
			}
			var batch []*visitDelta
			byID := map[string]*visitDelta{}
			for rows.Next() {
				v := &visitDelta{}
				h := &v.first
				if err := rows.Scan(&v.id, &h.OrgID, &h.VisitorKey, &v.startedAt, &v.lastAt, &v.pageviews, &v.actions, &v.engaged, &v.entry, &v.exit,
					&h.Referrer, &h.Channel, &h.UTMCampaign, &h.CountryCode, &h.Device, &h.Browser, &h.OS, &h.Language, &v.returning); err != nil {
					rows.Close()
					return fmt.Errorf("rebuild day: %w", err)
				}
				h.ProjectID = projectID
				// The visit keeps its day: its start, moved so that it falls on it.
				h.DayOffsetMs = day*store.DayMs - v.startedAt
				batch = append(batch, v)
				byID[v.id] = v
			}
			if err := rows.Close(); err != nil {
				return fmt.Errorf("rebuild day: %w", err)
			}
			if len(batch) == 0 {
				break
			}
			after = batch[len(batch)-1].id
			ids := make([]string, len(batch))
			for i, v := range batch {
				ids[i] = v.id
			}
			events, err := c.query(ctx, `SELECT visit_id, ts, kind, path, name, label, value, x, y, w, num, props FROM events
				WHERE visit_id IN (`+placeholders(len(ids))+`) ORDER BY visit_id, ts, id`, inArgs(ids)...)
			if err != nil {
				return fmt.Errorf("rebuild day: %w", err)
			}
			for events.Next() {
				var visit string
				var e store.Event
				if err := events.Scan(&visit, &e.Ts, &e.Kind, &e.Path, &e.Name, &e.Label, &e.Value, &e.X, &e.Y, &e.W, &e.Num, &e.Props); err != nil {
					events.Close()
					return fmt.Errorf("rebuild day: %w", err)
				}
				v := byID[visit]
				if len(v.events) == 0 {
					v.events = [][]store.Event{nil}
				}
				v.events[0] = append(v.events[0], e)
			}
			if err := events.Close(); err != nil {
				return fmt.Errorf("rebuild day: %w", err)
			}
			if err := d.applyDaily(ctx, c, rollUp(batch)); err != nil {
				return err
			}
			for _, v := range batch {
				if _, err := c.exec(ctx, "UPDATE visits SET counted = ? WHERE id = ?", v.counted, v.id); err != nil {
					return fmt.Errorf("rebuild day: %w", err)
				}
			}
		}
	}
	return nil
}
