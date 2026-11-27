package sqlstore

import (
	"cmp"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/dimmihq/kimmi/internal/store"
)

// maxURLs caps how many distinct paths a session remembers.
const maxURLs = 200

// rowsPerStatement keeps multi-row statements well under both databases'
// bound-parameter limits.
const rowsPerStatement = 400

// ApplyFlush indexes one flushed live object in a single transaction: block
// rows first (a repeated (session_id, seq) is skipped, which makes retries
// idempotent), then visitors and sessions from the batches that were new.
func (d *DB) ApplyFlush(ctx context.Context, blocks []store.IngestBlock, at int64) error {
	if len(blocks) == 0 {
		return nil
	}
	err := d.tx(ctx, func(c conn) error {
		fresh, err := insertBlocks(ctx, c, blocks)
		if err != nil || len(fresh) == 0 {
			return err
		}
		slices.SortFunc(fresh, func(a, b store.IngestBlock) int {
			return cmp.Or(strings.Compare(a.SessionID, b.SessionID), cmp.Compare(a.Seq, b.Seq))
		})
		existing, err := loadSessionHeads(ctx, c, fresh)
		if err != nil {
			return err
		}
		sessions := aggregateSessions(fresh, existing)
		visitorIDs, err := d.upsertVisitors(ctx, c, fresh, sessions)
		if err != nil {
			return err
		}
		if err := d.upsertSessions(ctx, c, sessions, visitorIDs); err != nil {
			return err
		}
		return upsertUsage(ctx, c, sessions, at)
	})
	if err != nil {
		return fmt.Errorf("apply flush: %w", err)
	}
	return nil
}

type blockKey struct {
	session string
	seq     int64
}

func insertBlocks(ctx context.Context, c conn, blocks []store.IngestBlock) ([]store.IngestBlock, error) {
	byKey := make(map[blockKey]store.IngestBlock, len(blocks))
	keys := make([]blockKey, 0, len(blocks))
	for _, b := range blocks {
		k := blockKey{b.SessionID, b.Seq}
		if _, dup := byKey[k]; !dup {
			keys = append(keys, k)
		}
		byKey[k] = b
	}
	var fresh []store.IngestBlock
	for part := range slices.Chunk(keys, rowsPerStatement) {
		args := make([]any, 0, len(part)*9)
		for _, k := range part {
			b := byKey[k]
			args = append(args, b.SessionID, b.Seq, b.ProjectID, b.FileKey, b.Offset, b.Length, b.FirstTs, b.LastTs, b.CreatedAt)
		}
		rows, err := c.query(ctx, `INSERT INTO blocks (session_id, seq, project_id, file_key, "offset", length, first_ts, last_ts, created_at)
			VALUES `+valueRows(len(part), 9)+` ON CONFLICT (session_id, seq) DO NOTHING RETURNING session_id, seq`, args...)
		if err != nil {
			return nil, fmt.Errorf("insert blocks: %w", err)
		}
		for rows.Next() {
			var k blockKey
			if err := rows.Scan(&k.session, &k.seq); err != nil {
				rows.Close()
				return nil, fmt.Errorf("insert blocks: %w", err)
			}
			fresh = append(fresh, byKey[k])
		}
		if err := rows.Close(); err != nil {
			return nil, fmt.Errorf("insert blocks: %w", err)
		}
	}
	return fresh, nil
}

// valueRows returns "(?, ?), (?, ?)" for n rows of cols values.
func valueRows(n, cols int) string {
	row := "(" + placeholders(cols) + ")"
	return strings.Repeat(row+", ", n-1) + row
}

type sessionHead struct {
	startedAt int64
	visitorID string
	urls      []string
}

func loadSessionHeads(ctx context.Context, c conn, fresh []store.IngestBlock) (map[string]sessionHead, error) {
	var ids []string
	for i, b := range fresh {
		if i == 0 || fresh[i-1].SessionID != b.SessionID {
			ids = append(ids, b.SessionID)
		}
	}
	out := make(map[string]sessionHead, len(ids))
	for part := range slices.Chunk(ids, rowsPerStatement) {
		rows, err := c.query(ctx, "SELECT id, started_at, visitor_id, urls FROM sessions WHERE id IN ("+placeholders(len(part))+")", inArgs(part)...)
		if err != nil {
			return nil, fmt.Errorf("load sessions: %w", err)
		}
		for rows.Next() {
			var id, urls string
			var h sessionHead
			if err := rows.Scan(&id, &h.startedAt, &h.visitorID, &urls); err != nil {
				rows.Close()
				return nil, fmt.Errorf("load sessions: %w", err)
			}
			_ = json.Unmarshal([]byte(urls), &h.urls)
			out[id] = h
		}
		if err := rows.Close(); err != nil {
			return nil, fmt.Errorf("load sessions: %w", err)
		}
	}
	return out, nil
}

// sessionDelta is what one flush adds to one session.
type sessionDelta struct {
	isNew  bool
	head   sessionHead
	first  store.IngestBlock // lowest seq in this flush
	last   store.IngestBlock // highest seq in this flush
	lastAt int64
	sum    store.IngestBlock // counters summed over the flush
	size   int64
	blocks int
	urls   []string
}

func aggregateSessions(fresh []store.IngestBlock, existing map[string]sessionHead) []*sessionDelta {
	var out []*sessionDelta
	var cur *sessionDelta
	for _, b := range fresh {
		if cur == nil || cur.first.SessionID != b.SessionID {
			head, found := existing[b.SessionID]
			if !found {
				head = sessionHead{startedAt: b.StartedAt}
			}
			cur = &sessionDelta{isNew: !found, head: head, first: b, urls: slices.Clone(head.urls)}
			out = append(out, cur)
		}
		cur.last = b
		cur.lastAt = max(cur.lastAt, b.LastTs)
		cur.sum.Clicks += b.Clicks
		cur.sum.Keypresses += b.Keypresses
		cur.sum.RageClicks += b.RageClicks
		cur.sum.DeadClicks += b.DeadClicks
		cur.sum.Errors += b.Errors
		cur.sum.Pageviews += b.Pageviews
		cur.sum.ActiveMs += b.ActiveMs
		cur.size += b.Length
		cur.blocks++
		for _, p := range append(slices.Clone(b.Paths), b.Path) {
			if p != "" && len(cur.urls) < maxURLs && !slices.Contains(cur.urls, p) {
				cur.urls = append(cur.urls, p)
			}
		}
	}
	return out
}

type visitorKey struct{ project, anonymous string }

type visitorDelta struct {
	latest            store.IngestBlock
	externalID, email string
	name              string
	traits            []byte
	firstSeen         int64
	lastSeen          int64
	newSessions       int
}

func (d *DB) upsertVisitors(ctx context.Context, c conn, fresh []store.IngestBlock, sessions []*sessionDelta) (map[visitorKey]string, error) {
	byKey := map[visitorKey]*visitorDelta{}
	var order []visitorKey
	for _, b := range fresh {
		k := visitorKey{b.ProjectID, b.AnonymousID}
		v := byKey[k]
		if v == nil {
			v = &visitorDelta{latest: b, firstSeen: b.FirstTs}
			byKey[k] = v
			order = append(order, k)
		}
		if b.LastTs >= v.latest.LastTs {
			v.latest = b
		}
		v.firstSeen = min(v.firstSeen, b.FirstTs)
		v.lastSeen = max(v.lastSeen, b.LastTs)
		v.externalID = cmp.Or(b.ExternalID, v.externalID)
		v.email = cmp.Or(b.Email, v.email)
		v.name = cmp.Or(b.Name, v.name)
		if len(b.Traits) > 0 {
			v.traits = b.Traits
		}
	}
	for _, s := range sessions {
		if s.isNew {
			byKey[visitorKey{s.first.ProjectID, s.first.AnonymousID}].newSessions++
		}
	}

	g, l := d.greatest(), d.least()
	ids := make(map[visitorKey]string, len(order))
	for part := range slices.Chunk(order, rowsPerStatement) {
		args := make([]any, 0, len(part)*17)
		for _, k := range part {
			v := byKey[k]
			b := v.latest
			var traits sql.NullString
			if len(v.traits) > 0 {
				traits = sql.NullString{String: string(v.traits), Valid: true}
			}
			args = append(args, store.NewID(), b.OrgID, b.ProjectID, b.AnonymousID,
				nullString(v.externalID), nullString(v.name), nullString(v.email), traits,
				b.Country, b.CountryCode, b.City, b.Device, b.Browser, b.OS, v.firstSeen, v.lastSeen, v.newSessions)
		}
		rows, err := c.query(ctx, `INSERT INTO visitors (id, org_id, project_id, anonymous_id, external_id, name, email, traits,
				country, country_code, city, device, browser, os, first_seen, last_seen, sessions)
			VALUES `+valueRows(len(part), 17)+`
			ON CONFLICT (project_id, anonymous_id) DO UPDATE SET
				external_id = COALESCE(excluded.external_id, visitors.external_id),
				name = COALESCE(excluded.name, visitors.name),
				email = COALESCE(excluded.email, visitors.email),
				traits = COALESCE(excluded.traits, visitors.traits),
				country = excluded.country, country_code = excluded.country_code, city = excluded.city,
				device = excluded.device, browser = excluded.browser, os = excluded.os,
				first_seen = `+l+`(visitors.first_seen, excluded.first_seen),
				last_seen = `+g+`(visitors.last_seen, excluded.last_seen),
				sessions = visitors.sessions + excluded.sessions
			RETURNING id, project_id, anonymous_id`, args...)
		if err != nil {
			return nil, fmt.Errorf("upsert visitors: %w", err)
		}
		for rows.Next() {
			var id string
			var k visitorKey
			if err := rows.Scan(&id, &k.project, &k.anonymous); err != nil {
				rows.Close()
				return nil, fmt.Errorf("upsert visitors: %w", err)
			}
			ids[k] = id
		}
		if err := rows.Close(); err != nil {
			return nil, fmt.Errorf("upsert visitors: %w", err)
		}
	}
	return ids, nil
}

func (d *DB) upsertSessions(ctx context.Context, c conn, sessions []*sessionDelta, visitorIDs map[visitorKey]string) error {
	g := d.greatest()
	for part := range slices.Chunk(sessions, rowsPerStatement) {
		args := make([]any, 0, len(part)*29)
		for _, s := range part {
			f, l := s.first, s.last
			visitorID := s.head.visitorID
			if visitorID == "" {
				visitorID = visitorIDs[visitorKey{f.ProjectID, f.AnonymousID}]
			}
			entry := f.Path
			if len(f.Paths) > 0 && f.Paths[0] != "" {
				entry = f.Paths[0]
			}
			args = append(args, f.SessionID, f.OrgID, f.ProjectID, visitorID, s.head.startedAt, s.lastAt,
				max(s.lastAt-s.head.startedAt, 0), s.sum.ActiveMs, s.sum.Pageviews, entry, l.Path, jsonText(s.urls),
				s.sum.Clicks, s.sum.Keypresses, s.sum.RageClicks, s.sum.DeadClicks, s.sum.Errors,
				l.ViewportW, l.ViewportH, l.Device, l.Browser, l.OS, l.CountryCode, l.City, f.Referrer, l.Release,
				s.size, s.blocks, l.Seq)
		}
		_, err := c.exec(ctx, `INSERT INTO sessions (id, org_id, project_id, visitor_id, started_at, last_at, duration_ms, active_ms,
				pages, entry_path, exit_path, urls, clicks, keypresses, rage_clicks, dead_clicks, errors, viewport_w, viewport_h,
				device, browser, os, country_code, city, referrer, release, size_bytes, block_count, last_seq)
			VALUES `+valueRows(len(part), 29)+`
			ON CONFLICT (id, started_at) DO UPDATE SET
				last_at = `+g+`(sessions.last_at, excluded.last_at),
				duration_ms = `+g+`(sessions.last_at, excluded.last_at) - sessions.started_at,
				active_ms = sessions.active_ms + excluded.active_ms,
				pages = sessions.pages + excluded.pages,
				exit_path = CASE WHEN excluded.last_seq > sessions.last_seq THEN excluded.exit_path ELSE sessions.exit_path END,
				urls = excluded.urls,
				clicks = sessions.clicks + excluded.clicks,
				keypresses = sessions.keypresses + excluded.keypresses,
				rage_clicks = sessions.rage_clicks + excluded.rage_clicks,
				dead_clicks = sessions.dead_clicks + excluded.dead_clicks,
				errors = sessions.errors + excluded.errors,
				viewport_w = excluded.viewport_w, viewport_h = excluded.viewport_h,
				release = CASE WHEN excluded.release <> '' THEN excluded.release ELSE sessions.release END,
				size_bytes = sessions.size_bytes + excluded.size_bytes,
				block_count = sessions.block_count + excluded.block_count,
				last_seq = `+g+`(sessions.last_seq, excluded.last_seq),
				sealed = FALSE`, args...)
		if err != nil {
			return fmt.Errorf("upsert sessions: %w", err)
		}
	}
	return nil
}

func upsertUsage(ctx context.Context, c conn, sessions []*sessionDelta, at int64) error {
	type usage struct {
		sessions int
		bytes    int64
	}
	byProject := map[string]*usage{}
	var projects []string
	for _, s := range sessions {
		u := byProject[s.first.ProjectID]
		if u == nil {
			u = &usage{}
			byProject[s.first.ProjectID] = u
			projects = append(projects, s.first.ProjectID)
		}
		if s.isNew {
			u.sessions++
		}
		u.bytes += s.size
	}
	day := time.UnixMilli(at).UTC().Format(time.DateOnly)
	args := make([]any, 0, len(projects)*4)
	for _, p := range projects {
		args = append(args, p, day, byProject[p].sessions, byProject[p].bytes)
	}
	_, err := c.exec(ctx, `INSERT INTO usage_daily (project_id, day, sessions, bytes) VALUES `+valueRows(len(projects), 4)+`
		ON CONFLICT (project_id, day) DO UPDATE SET sessions = usage_daily.sessions + excluded.sessions, bytes = usage_daily.bytes + excluded.bytes`, args...)
	if err != nil {
		return fmt.Errorf("upsert usage: %w", err)
	}
	return nil
}
