package sqlstore

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/dimmihq/kimmi/internal/geo"
	"github.com/dimmihq/kimmi/internal/store"
)

const visitorCols = "v.id, v.project_id, v.name, v.email, v.anonymous_id, v.external_id, v.country, v.country_code, v.city, v.device, v.browser, v.os, v.first_seen, v.last_seen, v.sessions"

const recordingSelect = `SELECT s.id, s.project_id, s.started_at, s.last_at, s.duration_ms, s.active_ms, s.pages, s.entry_path, s.exit_path,
	s.urls, s.clicks, s.keypresses, s.rage_clicks, s.dead_clicks, s.errors, s.viewport_w, s.viewport_h, s.device, s.browser,
	s.os, s.country_code, s.city, s.referrer, s.release, s.size_bytes, s.block_count, s.last_seq, s.seen, s.starred, s.sealed,
	s.sealed_key, s.sealed_chunks, ` + visitorCols + `
	FROM sessions s JOIN visitors v ON v.id = s.visitor_id`

func scanVisitor(dst []any, v *store.Visitor) []any {
	return append(dst, &v.ID, &v.ProjectID, &v.Name, &v.Email, &v.AnonymousID, &v.ExternalID, &v.Country, &v.CountryCode,
		&v.City, &v.Device, &v.Browser, &v.OS, &v.FirstSeen, &v.LastSeen, &v.Sessions)
}

func scanRecording(s interface{ Scan(...any) error }) (store.Recording, error) {
	var r store.Recording
	var urls string
	var key, chunks sql.NullString
	dst := []any{&r.ID, &r.ProjectID, &r.StartedAt, &r.LastAt, &r.DurationMs, &r.ActiveMs, &r.Pages, &r.EntryPath, &r.ExitPath,
		&urls, &r.Clicks, &r.Keypresses, &r.RageClicks, &r.DeadClicks, &r.Errors, &r.ViewportW, &r.ViewportH, &r.Device, &r.Browser,
		&r.OS, &r.CountryCode, &r.City, &r.Referrer, &r.Release, &r.SizeBytes, &r.BlockCount, &r.LastSeq, &r.Seen, &r.Starred, &r.Sealed,
		&key, &chunks}
	if err := s.Scan(scanVisitor(dst, &r.Visitor)...); err != nil {
		return r, err
	}
	r.SealedKey = key.String
	if err := json.Unmarshal([]byte(urls), &r.URLs); err != nil {
		return r, fmt.Errorf("recording %s urls: %w", r.ID, err)
	}
	if chunks.Valid {
		if err := json.Unmarshal([]byte(chunks.String), &r.SealedChunks); err != nil {
			return r, fmt.Errorf("recording %s chunks: %w", r.ID, err)
		}
	}
	return r, nil
}

func (d *DB) recordings(ctx context.Context, q string, args ...any) ([]store.Recording, error) {
	rows, err := d.r.query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []store.Recording{}
	for rows.Next() {
		r, err := scanRecording(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// filter collects SQL conditions and their arguments.
type filter struct {
	where []string
	args  []any
}

func (f *filter) add(cond string, args ...any) {
	f.where = append(f.where, cond)
	f.args = append(f.args, args...)
}

func (f *filter) sql() string { return " WHERE " + strings.Join(f.where, " AND ") }

func likeArg(q string) string {
	r := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return "%" + r.Replace(strings.ToLower(q)) + "%"
}

const (
	frictionCond = "(s.rage_clicks > 0 OR s.dead_clicks > 0 OR s.errors > 0)"
	minuteMs     = 60_000
)

func (d *DB) ListRecordings(ctx context.Context, q store.RecordingQuery) (store.RecordingPage, error) {
	var f filter
	f.add("s.project_id = ?", q.ProjectID)
	f.add("s.deleted_at IS NULL")
	if q.Q != "" {
		like := likeArg(q.Q)
		f.add(`(LOWER(v.name) LIKE ? ESCAPE '\' OR LOWER(v.email) LIKE ? ESCAPE '\' OR LOWER(v.external_id) LIKE ? ESCAPE '\'
			OR LOWER(s.urls) LIKE ? ESCAPE '\' OR LOWER(s.city) LIKE ? ESCAPE '\' OR s.id = ?)`, like, like, like, like, like, q.Q)
	}
	switch q.Duration {
	case "short":
		f.add("s.duration_ms < ?", minuteMs)
	case "medium":
		f.add("s.duration_ms >= ? AND s.duration_ms <= ?", minuteMs, 5*minuteMs)
	case "long":
		f.add("s.duration_ms > ?", 5*minuteMs)
	}
	if q.Device != "" && q.Device != "any" {
		f.add("s.device = ?", q.Device)
	}
	if q.Rage {
		f.add("s.rage_clicks > 0")
	}
	if q.Errors {
		f.add("s.errors > 0")
	}
	if q.VisitorID != "" {
		f.add("s.visitor_id = ?", q.VisitorID)
	}
	for _, c := range []struct{ col, val string }{
		{"entry_path", q.Entry}, {"exit_path", q.Exit}, {"country_code", q.Country},
		{"browser", q.Browser}, {"os", q.OS}, {"release", q.Release},
	} {
		if c.val != "" {
			f.add("s."+c.col+" = ?", c.val)
		}
	}
	if q.Path != "" {
		f.add("EXISTS (SELECT 1 FROM "+d.eachURL()+" WHERE u.value = ?)", q.Path)
	}
	// What a recording does not keep itself is read from its visit.
	var visit filter
	if q.Referrer == "Direct" {
		visit.add("vi.referrer = ''")
	} else if q.Referrer != "" {
		visit.add("vi.referrer = ?", q.Referrer)
	}
	for _, c := range []struct{ col, val string }{
		{"channel", q.Channel}, {"utm_source", q.UTMSource}, {"utm_campaign", q.UTMCampaign}, {"language", q.Language},
	} {
		if c.val != "" {
			visit.add("vi."+c.col+" = ?", c.val)
		}
	}
	if len(visit.where) > 0 {
		f.add("EXISTS (SELECT 1 FROM visits vi WHERE vi.id = s.id AND "+strings.Join(visit.where, " AND ")+")", visit.args...)
	}
	if q.EventKind != "" {
		event := filter{}
		event.add("e.kind = ?", q.EventKind)
		if q.EventName != "" {
			event.add("e.name = ?", q.EventName)
		}
		if q.EventPath != "" {
			event.add("e.path = ?", q.EventPath)
		}
		f.add("EXISTS (SELECT 1 FROM events e WHERE e.visit_id = s.id AND e.project_id = s.project_id AND "+
			strings.Join(event.where, " AND ")+")", event.args...)
	}

	var page store.RecordingPage
	err := d.r.row(ctx, `SELECT COUNT(*),
			COALESCE(SUM(CASE WHEN s.seen = FALSE THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN `+frictionCond+` THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN s.starred = TRUE THEN 1 ELSE 0 END), 0)
		FROM sessions s JOIN visitors v ON v.id = s.visitor_id`+f.sql(), f.args...).
		Scan(&page.Counts.All, &page.Counts.Unwatched, &page.Counts.Friction, &page.Counts.Starred)
	if err != nil {
		return page, fmt.Errorf("count recordings: %w", err)
	}
	page.Total = page.Counts.All
	switch q.View {
	case "unwatched":
		f.add("s.seen = FALSE")
		page.Total = page.Counts.Unwatched
	case "friction":
		f.add(frictionCond)
		page.Total = page.Counts.Friction
	case "starred":
		f.add("s.starred = TRUE")
		page.Total = page.Counts.Starred
	}
	limit := q.Limit
	if limit <= 0 {
		limit = 25
	}
	args := append(f.args, limit, max(q.Page, 0)*limit)
	order := "s.started_at DESC, s.id DESC"
	if q.Sort == "score" {
		order = "(s.errors * 5 + s.rage_clicks * 4 + s.dead_clicks * 2 + " + d.least() + "(s.pages, 10) + s.active_ms / 60000) DESC, " + order
	}
	page.Items, err = d.recordings(ctx, recordingSelect+f.sql()+" ORDER BY "+order+" LIMIT ? OFFSET ?", args...)
	if err != nil {
		return page, fmt.Errorf("list recordings: %w", err)
	}
	return page, nil
}

func (d *DB) GetRecording(ctx context.Context, projectID, id string) (store.Recording, error) {
	r, err := scanRecording(d.r.row(ctx, recordingSelect+" WHERE s.id = ? AND s.project_id = ? AND s.deleted_at IS NULL", id, projectID))
	if err != nil {
		return r, fmt.Errorf("get recording: %w", notFound(err))
	}
	return r, nil
}

func (d *DB) RecordingNeighbors(ctx context.Context, projectID string, r store.Recording) (string, string, error) {
	neighbor := func(cmp, order string) (string, error) {
		var id string
		err := d.r.row(ctx, `SELECT id FROM sessions WHERE project_id = ? AND deleted_at IS NULL
			AND (started_at `+cmp+` ? OR (started_at = ? AND id `+cmp+` ?))
			ORDER BY started_at `+order+`, id `+order+` LIMIT 1`, projectID, r.StartedAt, r.StartedAt, r.ID).Scan(&id)
		if err == sql.ErrNoRows {
			return "", nil
		}
		return id, err
	}
	newer, err := neighbor(">", "ASC")
	if err != nil {
		return "", "", fmt.Errorf("newer recording: %w", err)
	}
	older, err := neighbor("<", "DESC")
	if err != nil {
		return "", "", fmt.Errorf("older recording: %w", err)
	}
	return newer, older, nil
}

func (d *DB) SetRecordingFlags(ctx context.Context, projectID, id string, starred, seen *bool) error {
	var sets []string
	var args []any
	if starred != nil {
		sets, args = append(sets, "starred = ?"), append(args, *starred)
	}
	if seen != nil {
		sets, args = append(sets, "seen = ?"), append(args, *seen)
	}
	if len(sets) == 0 {
		return nil
	}
	args = append(args, id, projectID)
	if err := mustAffect(d.w.exec(ctx, "UPDATE sessions SET "+strings.Join(sets, ", ")+" WHERE id = ? AND project_id = ? AND deleted_at IS NULL", args...)); err != nil {
		return fmt.Errorf("set recording flags: %w", err)
	}
	return nil
}

func (d *DB) DeleteRecording(ctx context.Context, projectID, id string, at int64) error {
	err := d.tx(ctx, func(c conn) error {
		if err := mustAffect(c.exec(ctx, "UPDATE sessions SET deleted_at = ? WHERE id = ? AND project_id = ? AND deleted_at IS NULL", at, id, projectID)); err != nil {
			return err
		}
		_, err := c.exec(ctx, "DELETE FROM blocks WHERE session_id = ?", id)
		return err
	})
	if err != nil {
		return fmt.Errorf("delete recording: %w", err)
	}
	return nil
}

func (d *DB) DeleteRecordings(ctx context.Context, projectID string, startedBefore, at int64) (int, error) {
	if startedBefore <= 0 {
		startedBefore = math.MaxInt64
	}
	var n int64
	err := d.tx(ctx, func(c conn) error {
		res, err := c.exec(ctx, "UPDATE sessions SET deleted_at = ? WHERE project_id = ? AND started_at < ? AND deleted_at IS NULL", at, projectID, startedBefore)
		if err != nil {
			return err
		}
		if n, err = res.RowsAffected(); err != nil {
			return err
		}
		_, err = c.exec(ctx, `DELETE FROM blocks WHERE project_id = ? AND session_id IN
			(SELECT id FROM sessions WHERE project_id = ? AND deleted_at = ?)`, projectID, projectID, at)
		return err
	})
	if err != nil {
		return 0, fmt.Errorf("delete recordings: %w", err)
	}
	return int(n), nil
}

func (d *DB) ListBlocks(ctx context.Context, sessionID string, afterSeq int64) ([]store.Block, error) {
	rows, err := d.r.query(ctx, `SELECT session_id, seq, project_id, file_key, "offset", length, first_ts, last_ts, created_at
		FROM blocks WHERE session_id = ? AND seq > ? ORDER BY seq`, sessionID, afterSeq)
	if err != nil {
		return nil, fmt.Errorf("list blocks: %w", err)
	}
	defer rows.Close()
	var out []store.Block
	for rows.Next() {
		var b store.Block
		if err := rows.Scan(&b.SessionID, &b.Seq, &b.ProjectID, &b.FileKey, &b.Offset, &b.Length, &b.FirstTs, &b.LastTs, &b.CreatedAt); err != nil {
			return nil, fmt.Errorf("list blocks: %w", err)
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

// dayLabel names the day with index i (days since the epoch, already shifted
// into the project's time zone).
func dayLabel(i int64) string { return time.UnixMilli(i * store.DayMs).UTC().Format(time.DateOnly) }

func (d *DB) Overview(ctx context.Context, q store.OverviewQuery) (store.Overview, error) {
	o := store.Overview{Days: []store.DayFriction{}, TopPages: []store.PageStat{}, Devices: []store.NameCount{}, Countries: []store.CountryCount{}}
	var prev int
	err := d.r.row(ctx, `SELECT
			COALESCE(SUM(CASE WHEN started_at >= ? THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN started_at >= ? THEN 1 ELSE 0 END), 0),
			CAST(COALESCE(AVG(CASE WHEN started_at >= ? THEN duration_ms END), 0) AS BIGINT),
			CAST(COALESCE(AVG(CASE WHEN started_at >= ? THEN active_ms END), 0) AS BIGINT),
			COALESCE(SUM(CASE WHEN started_at >= ? AND (rage_clicks > 0 OR dead_clicks > 0) THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN started_at >= ? AND errors > 0 THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN started_at < ? THEN 1 ELSE 0 END), 0)
		FROM sessions WHERE project_id = ? AND deleted_at IS NULL AND started_at >= ? AND started_at < ?`,
		q.From, q.TodayFrom, q.From, q.From, q.From, q.From, q.From, q.ProjectID, q.PrevFrom, q.To).
		Scan(&o.Totals.Recordings, &o.Totals.Today, &o.Totals.AvgDurationMs, &o.Totals.AvgActiveMs,
			&o.Totals.FrictionSessions, &o.Totals.ErrorSessions, &prev)
	if err != nil {
		return o, fmt.Errorf("overview totals: %w", err)
	}
	switch {
	case prev > 0:
		o.Totals.TrendPercent = math.Round(float64(o.Totals.Recordings-prev)/float64(prev)*1000) / 10
	case o.Totals.Recordings > 0:
		o.Totals.TrendPercent = 100
	}

	first, last := (q.From+q.DayOffsetMs)/store.DayMs, (q.To-1+q.DayOffsetMs)/store.DayMs
	index := map[int64]int{}
	for i := first; i <= last; i++ {
		index[i] = len(o.Days)
		o.Days = append(o.Days, store.DayFriction{Date: dayLabel(i)})
	}
	rows, err := d.r.query(ctx, `SELECT (started_at + ?) / 86400000 AS d,
			SUM(CASE WHEN errors > 0 THEN 1 ELSE 0 END),
			SUM(CASE WHEN errors = 0 AND (rage_clicks > 0 OR dead_clicks > 0) THEN 1 ELSE 0 END),
			SUM(CASE WHEN errors = 0 AND rage_clicks = 0 AND dead_clicks = 0 THEN 1 ELSE 0 END)
		FROM sessions WHERE project_id = ? AND deleted_at IS NULL AND started_at >= ? AND started_at < ?
		GROUP BY d`, q.DayOffsetMs, q.ProjectID, q.From, q.To)
	if err != nil {
		return o, fmt.Errorf("overview days: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var day int64
		var e, f, c int
		if err := rows.Scan(&day, &e, &f, &c); err != nil {
			return o, fmt.Errorf("overview days: %w", err)
		}
		if i, ok := index[day]; ok {
			o.Days[i].Errors, o.Days[i].Friction, o.Days[i].Clean = e, f, c
		}
	}
	if err := rows.Err(); err != nil {
		return o, fmt.Errorf("overview days: %w", err)
	}

	window := []any{q.ProjectID, q.From, q.To}
	pages, err := d.r.query(ctx, `SELECT u.value, COUNT(*), SUM(CASE WHEN s.rage_clicks > 0 THEN 1 ELSE 0 END)
		FROM sessions s, `+d.eachURL()+`
		WHERE s.project_id = ? AND s.deleted_at IS NULL AND s.started_at >= ? AND s.started_at < ?
		GROUP BY u.value ORDER BY COUNT(*) DESC, u.value LIMIT 10`, window...)
	if err != nil {
		return o, fmt.Errorf("overview pages: %w", err)
	}
	defer pages.Close()
	for pages.Next() {
		var p store.PageStat
		if err := pages.Scan(&p.Path, &p.Views, &p.Rage); err != nil {
			return o, fmt.Errorf("overview pages: %w", err)
		}
		o.TopPages = append(o.TopPages, p)
	}
	if err := pages.Err(); err != nil {
		return o, fmt.Errorf("overview pages: %w", err)
	}

	where := " WHERE s.project_id = ? AND s.deleted_at IS NULL AND s.started_at >= ? AND s.started_at < ?"
	if o.Devices, err = d.nameCounts(ctx, "SELECT s.device, COUNT(*) FROM sessions s"+where+" GROUP BY s.device ORDER BY COUNT(*) DESC", window...); err != nil {
		return o, fmt.Errorf("overview devices: %w", err)
	}
	if o.Countries, err = d.countryCounts(ctx, "FROM sessions s"+where, window...); err != nil {
		return o, fmt.Errorf("overview countries: %w", err)
	}
	return o, nil
}

func (d *DB) nameCounts(ctx context.Context, q string, args ...any) ([]store.NameCount, error) {
	rows, err := d.r.query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []store.NameCount{}
	for rows.Next() {
		var n store.NameCount
		if err := rows.Scan(&n.Name, &n.Count); err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

// countryCounts groups the sessions selected by from (a "FROM ... WHERE ..."
// clause over alias s) by country, top 20.
func (d *DB) countryCounts(ctx context.Context, from string, args ...any) ([]store.CountryCount, error) {
	rows, err := d.r.query(ctx, "SELECT s.country_code, COUNT(*) "+from+
		" AND s.country_code <> '' GROUP BY s.country_code ORDER BY COUNT(*) DESC, s.country_code LIMIT 20", args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []store.CountryCount{}
	for rows.Next() {
		var c store.CountryCount
		if err := rows.Scan(&c.Code, &c.Count); err != nil {
			return nil, err
		}
		c.Name = geo.CountryName(c.Code)
		out = append(out, c)
	}
	return out, rows.Err()
}

func (d *DB) Live(ctx context.Context, projectID string, liveSince, activeSince int64) (store.Live, error) {
	var l store.Live
	err := d.r.row(ctx, `SELECT
			COUNT(DISTINCT CASE WHEN last_at >= ? THEN visitor_id END),
			COUNT(DISTINCT visitor_id)
		FROM sessions WHERE project_id = ? AND deleted_at IS NULL AND sealed = FALSE AND last_at >= ?`,
		liveSince, projectID, activeSince).Scan(&l.Visitors, &l.ActiveLast5m)
	if err != nil {
		return l, fmt.Errorf("live totals: %w", err)
	}
	from := " FROM sessions s WHERE s.project_id = ? AND s.deleted_at IS NULL AND s.sealed = FALSE AND s.last_at >= ?"
	args := []any{projectID, liveSince}
	pages, err := d.nameCounts(ctx, "SELECT s.exit_path, COUNT(*)"+from+" GROUP BY s.exit_path ORDER BY COUNT(*) DESC, s.exit_path LIMIT 20", args...)
	if err != nil {
		return l, fmt.Errorf("live pages: %w", err)
	}
	l.Pages = make([]store.PathCount, len(pages))
	for i, p := range pages {
		l.Pages[i] = store.PathCount{Path: p.Name, Count: p.Count}
	}
	if l.Countries, err = d.countryCounts(ctx, from, args...); err != nil {
		return l, fmt.Errorf("live countries: %w", err)
	}
	l.Sessions, err = d.recordings(ctx, recordingSelect+` WHERE s.project_id = ? AND s.deleted_at IS NULL AND s.sealed = FALSE
		AND s.last_at >= ? ORDER BY s.last_at DESC LIMIT 100`, args...)
	if err != nil {
		return l, fmt.Errorf("live sessions: %w", err)
	}
	return l, nil
}
