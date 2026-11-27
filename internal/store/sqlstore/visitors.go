package sqlstore

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/dimmihq/kimmi/internal/store"
)

const identified = "(v.external_id IS NOT NULL OR v.email IS NOT NULL)"

func (d *DB) ListVisitors(ctx context.Context, q store.VisitorQuery) (store.VisitorPage, error) {
	var f filter
	f.add("v.project_id = ?", q.ProjectID)
	if q.Q != "" {
		like := likeArg(q.Q)
		f.add(`(LOWER(v.name) LIKE ? ESCAPE '\' OR LOWER(v.email) LIKE ? ESCAPE '\' OR LOWER(v.external_id) LIKE ? ESCAPE '\'
			OR LOWER(v.anonymous_id) LIKE ? ESCAPE '\' OR LOWER(v.city) LIKE ? ESCAPE '\' OR v.id = ?)`, like, like, like, like, like, q.Q)
	}
	var page store.VisitorPage
	err := d.r.row(ctx, `SELECT COUNT(*), COALESCE(SUM(CASE WHEN `+identified+` THEN 1 ELSE 0 END), 0)
		FROM visitors v`+f.sql(), f.args...).Scan(&page.Counts.All, &page.Counts.Identified)
	if err != nil {
		return page, fmt.Errorf("count visitors: %w", err)
	}
	page.Counts.Anonymous = page.Counts.All - page.Counts.Identified
	page.Total = page.Counts.All
	switch q.Kind {
	case "identified":
		f.add(identified)
		page.Total = page.Counts.Identified
	case "anonymous":
		f.add("NOT " + identified)
		page.Total = page.Counts.Anonymous
	}
	order := "v.last_seen DESC"
	switch q.Sort {
	case "sessions":
		order = "v.sessions DESC, v.last_seen DESC"
	case "firstSeen":
		order = "v.first_seen DESC"
	}
	limit := q.Limit
	if limit <= 0 {
		limit = 25
	}
	rows, err := d.r.query(ctx, "SELECT "+visitorCols+" FROM visitors v"+f.sql()+" ORDER BY "+order+", v.id LIMIT ? OFFSET ?",
		append(f.args, limit, max(q.Page, 0)*limit)...)
	if err != nil {
		return page, fmt.Errorf("list visitors: %w", err)
	}
	defer rows.Close()
	page.Items = []store.Visitor{}
	for rows.Next() {
		var v store.Visitor
		if err := rows.Scan(scanVisitor(nil, &v)...); err != nil {
			return page, fmt.Errorf("list visitors: %w", err)
		}
		page.Items = append(page.Items, v)
	}
	return page, rows.Err()
}

func (d *DB) GetVisitor(ctx context.Context, projectID, id string) (store.Visitor, error) {
	var v store.Visitor
	err := d.r.row(ctx, "SELECT "+visitorCols+" FROM visitors v WHERE v.id = ? AND v.project_id = ?", id, projectID).Scan(scanVisitor(nil, &v)...)
	if err != nil {
		return v, fmt.Errorf("get visitor: %w", notFound(err))
	}
	return v, nil
}

func (d *DB) VisitorDetail(ctx context.Context, projectID, id string, activityFrom, dayOffsetMs int64) (store.VisitorStats, []store.DayCount, error) {
	var s store.VisitorStats
	err := d.r.row(ctx, `SELECT COUNT(*), CAST(COALESCE(SUM(duration_ms), 0) AS BIGINT), COALESCE(SUM(rage_clicks), 0), COALESCE(SUM(errors), 0)
		FROM sessions WHERE project_id = ? AND visitor_id = ? AND deleted_at IS NULL`, projectID, id).
		Scan(&s.Sessions, &s.TotalDurationMs, &s.RageClicks, &s.Errors)
	if err != nil {
		return s, nil, fmt.Errorf("visitor stats: %w", err)
	}
	first := (activityFrom + dayOffsetMs) / store.DayMs
	activity := make([]store.DayCount, 84)
	for i := range activity {
		activity[i].Date = dayLabel(first + int64(i))
	}
	rows, err := d.r.query(ctx, `SELECT (started_at + ?) / 86400000 AS d, COUNT(*) FROM sessions
		WHERE project_id = ? AND visitor_id = ? AND deleted_at IS NULL AND started_at >= ? GROUP BY d`,
		dayOffsetMs, projectID, id, first*store.DayMs-dayOffsetMs)
	if err != nil {
		return s, nil, fmt.Errorf("visitor activity: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var day int64
		var n int
		if err := rows.Scan(&day, &n); err != nil {
			return s, nil, fmt.Errorf("visitor activity: %w", err)
		}
		if i := day - first; i >= 0 && i < 84 {
			activity[i].Count = n
		}
	}
	return s, activity, rows.Err()
}

func (d *DB) FindVisitors(ctx context.Context, projectID, query string) ([]string, error) {
	rows, err := d.r.query(ctx, `SELECT id FROM visitors WHERE project_id = ? AND (id = ? OR external_id = ? OR LOWER(email) = LOWER(?))`,
		projectID, query, query, query)
	if err != nil {
		return nil, fmt.Errorf("find visitors: %w", err)
	}
	return scanIDs(rows)
}

// FindVisitorsByExternalIDPrefix escapes the prefix for LIKE, so % and _
// are literal, and compares the leading characters again because SQLite's
// LIKE ignores case.
func (d *DB) FindVisitorsByExternalIDPrefix(ctx context.Context, projectID, prefix string) ([]string, error) {
	like := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(prefix) + "%"
	rows, err := d.r.query(ctx, `SELECT id FROM visitors WHERE project_id = ? AND external_id LIKE ? ESCAPE '\'
		AND SUBSTR(external_id, 1, ?) = ?`, projectID, like, utf8.RuneCountInString(prefix), prefix)
	if err != nil {
		return nil, fmt.Errorf("find visitors: %w", err)
	}
	return scanIDs(rows)
}

func scanIDs(rows *sql.Rows) ([]string, error) {
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("find visitors: %w", err)
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func (d *DB) DeleteVisitor(ctx context.Context, projectID, id string, at int64) error {
	err := d.tx(ctx, func(c conn) error {
		if err := mustAffect(c.exec(ctx, "DELETE FROM visitors WHERE id = ? AND project_id = ?", id, projectID)); err != nil {
			return err
		}
		if _, err := c.exec(ctx, "DELETE FROM blocks WHERE session_id IN (SELECT id FROM sessions WHERE visitor_id = ? AND project_id = ?)", id, projectID); err != nil {
			return err
		}
		_, err := c.exec(ctx, "UPDATE sessions SET deleted_at = ? WHERE visitor_id = ? AND project_id = ? AND deleted_at IS NULL", at, id, projectID)
		return err
	})
	if err != nil {
		return fmt.Errorf("delete visitor: %w", err)
	}
	return nil
}
