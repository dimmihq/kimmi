package sqlstore

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"slices"

	"github.com/dimmihq/kimmi/internal/store"
)

// visitGapMs is how long a cookieless visitor may stay away and still be
// in the same visit.
const visitGapMs = 30 * 60 * 1000

// visitDelta is what one flush adds to one visit.
type visitDelta struct {
	id        string
	first     store.Hit
	startedAt int64
	lastAt    int64
	pageviews int
	actions   int
	engaged   int64
	entry     string
	exit      string
	events    []store.Event
	returning bool
}

func (d *DB) ApplyHits(ctx context.Context, hits []store.Hit) error {
	if len(hits) == 0 {
		return nil
	}
	err := d.tx(ctx, func(c conn) error {
		deltas, err := aggregateVisits(ctx, c, hits)
		if err != nil {
			return err
		}
		if err := d.upsertVisits(ctx, c, deltas); err != nil {
			return err
		}
		return insertEvents(ctx, c, deltas)
	})
	if err != nil {
		return fmt.Errorf("apply hits: %w", err)
	}
	return nil
}

// aggregateVisits groups hits by visit. A cookieless hit joins the visit
// its visitor had in the last 30 minutes, in the database or in this flush.
func aggregateVisits(ctx context.Context, c conn, hits []store.Hit) ([]*visitDelta, error) {
	byID := map[string]*visitDelta{}
	var out []*visitDelta
	// stitched remembers, per cookieless visitor, the visit their last hit
	// of this flush went to and when.
	type open struct {
		id string
		at int64
	}
	stitched := map[string]open{}
	for _, h := range hits {
		id := h.VisitID
		if h.Cookieless {
			key := h.ProjectID + " " + h.VisitorKey
			if known, ok := stitched[key]; ok && h.At-known.at <= visitGapMs {
				id = known.id
			} else if !ok {
				var found string
				err := c.row(ctx, `SELECT id FROM visits WHERE project_id = ? AND visitor_key = ? AND last_at >= ?
					ORDER BY last_at DESC LIMIT 1`, h.ProjectID, h.VisitorKey, h.At-visitGapMs).Scan(&found)
				switch {
				case err == nil:
					id = found
				case !errors.Is(err, sql.ErrNoRows):
					return nil, fmt.Errorf("find visit: %w", err)
				}
			}
			stitched[key] = open{id, h.At}
		}
		v := byID[id]
		if v == nil {
			started := h.StartedAt
			if started <= 0 || started > h.At || started < h.At-store.DayMs {
				started = h.At
			}
			v = &visitDelta{id: id, first: h, startedAt: started}
			byID[id] = v
			out = append(out, v)
		}
		v.lastAt = max(v.lastAt, h.At)
		for _, e := range h.Events {
			switch e.Kind {
			case store.KindPage:
				v.pageviews++
				if v.entry == "" {
					v.entry = e.Path
				}
				v.exit = e.Path
			case store.KindTrack, store.KindClick:
				v.actions++
			case store.KindLeave:
				v.engaged += int64(e.Value)
			}
		}
		v.events = append(v.events, h.Events...)
	}

	ids := make([]string, len(out))
	for i, v := range out {
		ids[i] = v.id
	}
	owner := map[string]string{}
	for part := range slices.Chunk(ids, rowsPerStatement) {
		rows, err := c.query(ctx, "SELECT id, project_id FROM visits WHERE id IN ("+placeholders(len(part))+")", inArgs(part)...)
		if err != nil {
			return nil, fmt.Errorf("load visits: %w", err)
		}
		for rows.Next() {
			var id, project string
			if err := rows.Scan(&id, &project); err != nil {
				rows.Close()
				return nil, fmt.Errorf("load visits: %w", err)
			}
			owner[id] = project
		}
		if err := rows.Close(); err != nil {
			return nil, fmt.Errorf("load visits: %w", err)
		}
	}
	// A visit id is chosen by the browser: one that already belongs to
	// another project is dropped with its events.
	out = slices.DeleteFunc(out, func(v *visitDelta) bool {
		project, exists := owner[v.id]
		return exists && project != v.first.ProjectID
	})
	earlier := map[string]bool{}
	for _, v := range out {
		key := v.first.ProjectID + " " + v.first.VisitorKey
		_, exists := owner[v.id]
		if exists || v.first.Cookieless {
			earlier[key] = true
			continue
		}
		if earlier[key] {
			v.returning = true
			continue
		}
		earlier[key] = true
		var one int
		err := c.row(ctx, "SELECT 1 FROM visits WHERE project_id = ? AND visitor_key = ? LIMIT 1", v.first.ProjectID, v.first.VisitorKey).Scan(&one)
		switch {
		case err == nil:
			v.returning = true
		case !errors.Is(err, sql.ErrNoRows):
			return nil, fmt.Errorf("find earlier visit: %w", err)
		}
	}
	return out, nil
}

func (d *DB) upsertVisits(ctx context.Context, c conn, deltas []*visitDelta) error {
	g := d.greatest()
	const cols = 25
	for part := range slices.Chunk(deltas, rowsPerStatement) {
		args := make([]any, 0, len(part)*cols)
		for _, v := range part {
			h := v.first
			args = append(args, v.id, h.OrgID, h.ProjectID, h.VisitorKey, v.startedAt, v.lastAt, v.pageviews, v.actions, v.engaged,
				v.entry, v.exit, h.Referrer, h.Channel, h.UTMSource, h.UTMMedium, h.UTMCampaign,
				h.CountryCode, h.Device, h.Browser, h.OS, h.Language, h.ViewportW, h.Release, v.returning, h.Cookieless)
		}
		_, err := c.exec(ctx, `INSERT INTO visits (id, org_id, project_id, visitor_key, started_at, last_at, pageviews, actions, engaged_ms,
				entry_path, exit_path, referrer, channel, utm_source, utm_medium, utm_campaign,
				country_code, device, browser, os, language, viewport_w, release, is_returning, cookieless)
			VALUES `+valueRows(len(part), cols)+`
			ON CONFLICT (id) DO UPDATE SET
				last_at = `+g+`(visits.last_at, excluded.last_at),
				pageviews = visits.pageviews + excluded.pageviews,
				actions = visits.actions + excluded.actions,
				engaged_ms = visits.engaged_ms + excluded.engaged_ms,
				entry_path = CASE WHEN visits.entry_path = '' THEN excluded.entry_path ELSE visits.entry_path END,
				exit_path = CASE WHEN excluded.exit_path <> '' THEN excluded.exit_path ELSE visits.exit_path END,
				release = CASE WHEN excluded.release <> '' THEN excluded.release ELSE visits.release END
			WHERE visits.project_id = excluded.project_id`, args...)
		if err != nil {
			return fmt.Errorf("upsert visits: %w", err)
		}
	}
	return nil
}

func insertEvents(ctx context.Context, c conn, deltas []*visitDelta) error {
	type row struct {
		v *visitDelta
		e store.Event
	}
	var all []row
	for _, v := range deltas {
		for _, e := range v.events {
			all = append(all, row{v, e})
		}
	}
	const cols = 14
	for part := range slices.Chunk(all, rowsPerStatement) {
		args := make([]any, 0, len(part)*cols)
		for _, r := range part {
			e := r.e
			args = append(args, r.v.first.OrgID, r.v.first.ProjectID, r.v.id, e.Ts, e.Kind, e.Path, e.Name, e.Label, e.Value, e.X, e.Y, e.W, e.Num, e.Props)
		}
		if _, err := c.exec(ctx, `INSERT INTO events (org_id, project_id, visit_id, ts, kind, path, name, label, value, x, y, w, num, props)
			VALUES `+valueRows(len(part), cols), args...); err != nil {
			return fmt.Errorf("insert events: %w", err)
		}
	}
	return nil
}

func (d *DB) DaySalt(ctx context.Context, day string) (string, error) {
	fresh := make([]byte, 16)
	if _, err := rand.Read(fresh); err != nil {
		return "", fmt.Errorf("day salt: %w", err)
	}
	var salt string
	err := d.tx(ctx, func(c conn) error {
		if _, err := c.exec(ctx, "INSERT INTO salts (day, salt) VALUES (?, ?) ON CONFLICT (day) DO NOTHING", day, hex.EncodeToString(fresh)); err != nil {
			return err
		}
		if err := c.row(ctx, "SELECT salt FROM salts WHERE day = ?", day).Scan(&salt); err != nil {
			return err
		}
		_, err := c.exec(ctx, "DELETE FROM salts WHERE day < ?", day)
		return err
	})
	if err != nil {
		return "", fmt.Errorf("day salt: %w", err)
	}
	return salt, nil
}

func (d *DB) CountEvents(ctx context.Context, projectID, kind string, since int64) (int, error) {
	var n int
	if err := d.r.row(ctx, "SELECT COUNT(*) FROM events WHERE project_id = ? AND kind = ? AND ts >= ?", projectID, kind, since).Scan(&n); err != nil {
		return 0, fmt.Errorf("count events: %w", err)
	}
	return n, nil
}

func (d *DB) EventSeenBefore(ctx context.Context, projectID, kind, name string, before int64) (bool, error) {
	var one int
	err := d.r.row(ctx, "SELECT 1 FROM events WHERE project_id = ? AND kind = ? AND name = ? AND ts < ? LIMIT 1", projectID, kind, name, before).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("event seen before: %w", err)
	}
	return true, nil
}

func (d *DB) LastVisitAt(ctx context.Context, projectID string) (int64, error) {
	var at int64
	if err := d.r.row(ctx, "SELECT COALESCE(MAX(last_at), 0) FROM visits WHERE project_id = ?", projectID).Scan(&at); err != nil {
		return 0, fmt.Errorf("last visit: %w", err)
	}
	return at, nil
}

func (d *DB) DeleteAnalyticsBefore(ctx context.Context, projectID string, before int64) (int, error) {
	var n int64
	err := d.tx(ctx, func(c conn) error {
		if _, err := c.exec(ctx, "DELETE FROM events WHERE project_id = ? AND ts < ?", projectID, before); err != nil {
			return err
		}
		if _, err := c.exec(ctx, "DELETE FROM feedback WHERE project_id = ? AND created_at < ?", projectID, before); err != nil {
			return err
		}
		res, err := c.exec(ctx, "DELETE FROM visits WHERE project_id = ? AND last_at < ?", projectID, before)
		if err != nil {
			return err
		}
		n, err = res.RowsAffected()
		return err
	})
	if err != nil {
		return 0, fmt.Errorf("delete analytics: %w", err)
	}
	return int(n), nil
}

// deleteVisitorAnalytics removes what the event index, feedback, notes and
// share links hold about one visitor. It runs inside DeleteVisitor's
// transaction, before the visitor's recordings are marked deleted.
func deleteVisitorAnalytics(ctx context.Context, c conn, projectID, visitorID, anonymousID string) error {
	key := "a:" + anonymousID
	visits := "SELECT id FROM visits WHERE project_id = ? AND visitor_key = ?"
	sessions := "SELECT id FROM sessions WHERE visitor_id = ? AND project_id = ?"
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{"DELETE FROM events WHERE visit_id IN (" + visits + ")", []any{projectID, key}},
		{"DELETE FROM events WHERE visit_id IN (" + sessions + ")", []any{visitorID, projectID}},
		{"DELETE FROM feedback WHERE project_id = ? AND (visitor_key = ? OR visit_id IN (" + sessions + "))", []any{projectID, key, visitorID, projectID}},
		{"DELETE FROM visits WHERE id IN (" + sessions + ")", []any{visitorID, projectID}},
		{"DELETE FROM visits WHERE project_id = ? AND visitor_key = ?", []any{projectID, key}},
		{"DELETE FROM notes WHERE session_id IN (" + sessions + ")", []any{visitorID, projectID}},
		{"DELETE FROM shares WHERE session_id IN (" + sessions + ")", []any{visitorID, projectID}},
	} {
		if _, err := c.exec(ctx, q.sql, q.args...); err != nil {
			return err
		}
	}
	return nil
}

// deleteProjectAnalytics removes everything a project holds beside its
// recordings. It runs inside DeleteProject's transaction.
func deleteProjectAnalytics(ctx context.Context, c conn, projectID string) error {
	for _, table := range []string{"events", "visits", "feedback", "notes", "shares", "project_state"} {
		if _, err := c.exec(ctx, "DELETE FROM "+table+" WHERE project_id = ?", projectID); err != nil {
			return err
		}
	}
	return nil
}

// deleteOrphans removes the notes and share links of recordings that no
// longer exist. It runs after recordings are purged.
func deleteOrphans(ctx context.Context, c conn) error {
	if _, err := c.exec(ctx, "DELETE FROM notes WHERE session_id NOT IN (SELECT id FROM sessions WHERE deleted_at IS NULL)"); err != nil {
		return err
	}
	_, err := c.exec(ctx, "DELETE FROM shares WHERE kind = ? AND session_id NOT IN (SELECT id FROM sessions WHERE deleted_at IS NULL)", store.ShareRecording)
	return err
}

func (d *DB) CreateNote(ctx context.Context, n store.Note) error {
	_, err := d.w.exec(ctx, `INSERT INTO notes (id, org_id, project_id, session_id, user_id, at_ms, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		n.ID, n.OrgID, n.ProjectID, n.SessionID, n.UserID, n.AtMs, n.Body, n.CreatedAt)
	if err != nil {
		return fmt.Errorf("create note: %w", err)
	}
	return nil
}

func (d *DB) ListNotes(ctx context.Context, projectID, sessionID string) ([]store.Note, error) {
	rows, err := d.r.query(ctx, `SELECT n.id, n.session_id, n.user_id, COALESCE(u.name, ''), n.at_ms, n.body, n.created_at
		FROM notes n LEFT JOIN users u ON u.id = n.user_id
		WHERE n.project_id = ? AND n.session_id = ? ORDER BY n.at_ms, n.created_at`, projectID, sessionID)
	if err != nil {
		return nil, fmt.Errorf("list notes: %w", err)
	}
	defer rows.Close()
	out := []store.Note{}
	for rows.Next() {
		var n store.Note
		if err := rows.Scan(&n.ID, &n.SessionID, &n.UserID, &n.Author, &n.AtMs, &n.Body, &n.CreatedAt); err != nil {
			return nil, fmt.Errorf("list notes: %w", err)
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

func (d *DB) DeleteNote(ctx context.Context, projectID, id string) error {
	if err := mustAffect(d.w.exec(ctx, "DELETE FROM notes WHERE id = ? AND project_id = ?", id, projectID)); err != nil {
		return fmt.Errorf("delete note: %w", err)
	}
	return nil
}

func (d *DB) CreateShare(ctx context.Context, s store.Share) error {
	_, err := d.w.exec(ctx, `INSERT INTO shares (id, org_id, project_id, kind, session_id, start_ms, token_hash, created_by, created_at, expires_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, s.ID, s.OrgID, s.ProjectID, s.Kind, s.SessionID, s.StartMs, s.TokenHash, s.CreatedBy, s.CreatedAt, s.ExpiresAt)
	if err != nil {
		return fmt.Errorf("create share: %w", err)
	}
	return nil
}

const shareCols = "sh.id, sh.org_id, sh.project_id, sh.kind, sh.session_id, sh.start_ms, sh.created_by, COALESCE(u.name, ''), sh.created_at, sh.expires_at"

func scanShare(s interface{ Scan(...any) error }) (store.Share, error) {
	var sh store.Share
	err := s.Scan(&sh.ID, &sh.OrgID, &sh.ProjectID, &sh.Kind, &sh.SessionID, &sh.StartMs, &sh.CreatedBy, &sh.Author, &sh.CreatedAt, &sh.ExpiresAt)
	return sh, err
}

// shareAlive holds for a link whose recording, if it points at one, exists.
const shareAlive = `(sh.kind <> 'recording' OR EXISTS (SELECT 1 FROM sessions s WHERE s.id = sh.session_id AND s.deleted_at IS NULL))`

func (d *DB) ListShares(ctx context.Context, projectID string, now int64) ([]store.Share, error) {
	rows, err := d.r.query(ctx, `SELECT `+shareCols+` FROM shares sh LEFT JOIN users u ON u.id = sh.created_by
		WHERE sh.project_id = ? AND sh.expires_at > ? AND `+shareAlive+` ORDER BY sh.created_at DESC`, projectID, now)
	if err != nil {
		return nil, fmt.Errorf("list shares: %w", err)
	}
	defer rows.Close()
	out := []store.Share{}
	for rows.Next() {
		sh, err := scanShare(rows)
		if err != nil {
			return nil, fmt.Errorf("list shares: %w", err)
		}
		out = append(out, sh)
	}
	return out, rows.Err()
}

func (d *DB) GetShareByHash(ctx context.Context, tokenHash string, now int64) (store.Share, error) {
	sh, err := scanShare(d.r.row(ctx, `SELECT `+shareCols+` FROM shares sh
		JOIN projects p ON p.id = sh.project_id AND p.deleted_at IS NULL
		LEFT JOIN users u ON u.id = sh.created_by
		WHERE sh.token_hash = ? AND sh.expires_at > ? AND `+shareAlive, tokenHash, now))
	if err != nil {
		return sh, fmt.Errorf("get share: %w", notFound(err))
	}
	return sh, nil
}

func (d *DB) DeleteShare(ctx context.Context, projectID, id string) error {
	if err := mustAffect(d.w.exec(ctx, "DELETE FROM shares WHERE id = ? AND project_id = ?", id, projectID)); err != nil {
		return fmt.Errorf("delete share: %w", err)
	}
	return nil
}

func (d *DB) CreateFeedback(ctx context.Context, f store.Feedback) error {
	_, err := d.w.exec(ctx, `INSERT INTO feedback (id, org_id, project_id, visit_id, visitor_key, path, body, email, created_at, seen)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, f.ID, f.OrgID, f.ProjectID, f.VisitID, f.VisitorKey, f.Path, f.Body, f.Email, f.CreatedAt, f.Seen)
	if err != nil {
		return fmt.Errorf("create feedback: %w", err)
	}
	return nil
}

func (d *DB) ListFeedback(ctx context.Context, projectID string, page, limit int) (store.FeedbackPage, error) {
	out := store.FeedbackPage{Items: []store.Feedback{}}
	if err := d.r.row(ctx, `SELECT COUNT(*), COALESCE(SUM(CASE WHEN seen THEN 0 ELSE 1 END), 0) FROM feedback WHERE project_id = ?`, projectID).
		Scan(&out.Total, &out.Unseen); err != nil {
		return out, fmt.Errorf("count feedback: %w", err)
	}
	rows, err := d.r.query(ctx, `SELECT f.id, f.visit_id, f.path, f.body, f.email, f.created_at, f.seen, s.id IS NOT NULL, COALESCE(s.started_at, 0)
		FROM feedback f LEFT JOIN sessions s ON s.id = f.visit_id AND s.deleted_at IS NULL
		WHERE f.project_id = ? ORDER BY f.created_at DESC, f.id LIMIT ? OFFSET ?`, projectID, limit, page*limit)
	if err != nil {
		return out, fmt.Errorf("list feedback: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var f store.Feedback
		if err := rows.Scan(&f.ID, &f.VisitID, &f.Path, &f.Body, &f.Email, &f.CreatedAt, &f.Seen, &f.Recorded, &f.StartedAt); err != nil {
			return out, fmt.Errorf("list feedback: %w", err)
		}
		out.Items = append(out.Items, f)
	}
	return out, rows.Err()
}

func (d *DB) SetFeedbackSeen(ctx context.Context, projectID, id string, seen bool) error {
	if err := mustAffect(d.w.exec(ctx, "UPDATE feedback SET seen = ? WHERE id = ? AND project_id = ?", seen, id, projectID)); err != nil {
		return fmt.Errorf("update feedback: %w", err)
	}
	return nil
}

func (d *DB) DeleteFeedback(ctx context.Context, projectID, id string) error {
	if err := mustAffect(d.w.exec(ctx, "DELETE FROM feedback WHERE id = ? AND project_id = ?", id, projectID)); err != nil {
		return fmt.Errorf("delete feedback: %w", err)
	}
	return nil
}

func (d *DB) GetState(ctx context.Context, projectID, name string) (string, error) {
	var v string
	err := d.r.row(ctx, "SELECT value FROM project_state WHERE project_id = ? AND name = ?", projectID, name).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("get state: %w", err)
	}
	return v, nil
}

func (d *DB) SetState(ctx context.Context, projectID, name, value string, at int64) error {
	_, err := d.w.exec(ctx, `INSERT INTO project_state (project_id, name, value, updated_at) VALUES (?, ?, ?, ?)
		ON CONFLICT (project_id, name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, projectID, name, value, at)
	if err != nil {
		return fmt.Errorf("set state: %w", err)
	}
	return nil
}
