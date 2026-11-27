package sqlstore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/dimmihq/kimmi/internal/store"
)

// dayMsSQL is one day in milliseconds as a 64-bit SQL value, so that
// retention_days * day cannot overflow a PostgreSQL integer.
const dayMsSQL = "CAST(86400000 AS BIGINT)"

// keptCond is true for a session its project's retention spares.
const keptCond = "(p.keep_starred = TRUE AND s.starred = TRUE)"

func (d *DB) SealCandidates(ctx context.Context, idleBefore int64, limit int) ([]store.SealCandidate, error) {
	rows, err := d.r.query(ctx, `SELECT s.id, s.project_id, p.retention_days, s.sealed_key, s.sealed_chunks
		FROM sessions s JOIN projects p ON p.id = s.project_id
		WHERE s.sealed = FALSE AND s.deleted_at IS NULL AND s.last_at < ?
		ORDER BY s.last_at LIMIT ?`, idleBefore, limit)
	if err != nil {
		return nil, fmt.Errorf("seal candidates: %w", err)
	}
	var out []store.SealCandidate
	index := map[string]int{}
	for rows.Next() {
		var c store.SealCandidate
		var key, chunks sql.NullString
		if err := rows.Scan(&c.ID, &c.ProjectID, &c.RetentionDays, &key, &chunks); err != nil {
			rows.Close()
			return nil, fmt.Errorf("seal candidates: %w", err)
		}
		c.SealedKey = key.String
		if chunks.Valid {
			if err := json.Unmarshal([]byte(chunks.String), &c.SealedChunks); err != nil {
				rows.Close()
				return nil, fmt.Errorf("session %s chunks: %w", c.ID, err)
			}
		}
		index[c.ID] = len(out)
		out = append(out, c)
	}
	if err := rows.Close(); err != nil {
		return nil, fmt.Errorf("seal candidates: %w", err)
	}
	ids := make([]string, len(out))
	for i, c := range out {
		ids[i] = c.ID
	}
	for part := range slices.Chunk(ids, rowsPerStatement) {
		blocks, err := d.r.query(ctx, `SELECT session_id, seq, project_id, file_key, "offset", length, first_ts, last_ts, created_at
			FROM blocks WHERE session_id IN (`+placeholders(len(part))+`) ORDER BY session_id, seq`, inArgs(part)...)
		if err != nil {
			return nil, fmt.Errorf("seal candidate blocks: %w", err)
		}
		for blocks.Next() {
			var b store.Block
			if err := blocks.Scan(&b.SessionID, &b.Seq, &b.ProjectID, &b.FileKey, &b.Offset, &b.Length, &b.FirstTs, &b.LastTs, &b.CreatedAt); err != nil {
				blocks.Close()
				return nil, fmt.Errorf("seal candidate blocks: %w", err)
			}
			c := &out[index[b.SessionID]]
			c.Blocks = append(c.Blocks, b)
		}
		if err := blocks.Close(); err != nil {
			return nil, fmt.Errorf("seal candidate blocks: %w", err)
		}
	}
	return out, nil
}

func (d *DB) SealSession(ctx context.Context, r store.SealResult) error {
	err := d.tx(ctx, func(c conn) error {
		if _, err := c.exec(ctx, "DELETE FROM blocks WHERE session_id = ? AND seq <= ?", r.SessionID, r.UpToSeq); err != nil {
			return err
		}
		var key, chunks any
		if r.Key != "" {
			key, chunks = r.Key, jsonText(r.Chunks)
		}
		// A batch that arrived while sealing keeps the session open for the next run.
		_, err := c.exec(ctx, `UPDATE sessions SET sealed_key = ?, sealed_chunks = ?, size_bytes = ?, last_seq = `+d.greatest()+`(last_seq, ?),
			sealed = NOT EXISTS (SELECT 1 FROM blocks WHERE blocks.session_id = sessions.id)
			WHERE id = ? AND deleted_at IS NULL`, key, chunks, r.SizeBytes, r.LastSeq, r.SessionID)
		return err
	})
	if err != nil {
		return fmt.Errorf("seal session %s: %w", r.SessionID, err)
	}
	return nil
}

func (d *DB) LiveKeysInUse(ctx context.Context, keys []string) (map[string]bool, error) {
	out := map[string]bool{}
	for part := range slices.Chunk(keys, rowsPerStatement) {
		rows, err := d.r.query(ctx, "SELECT DISTINCT file_key FROM blocks WHERE file_key IN ("+placeholders(len(part))+")", inArgs(part)...)
		if err != nil {
			return nil, fmt.Errorf("live keys in use: %w", err)
		}
		for rows.Next() {
			var k string
			if err := rows.Scan(&k); err != nil {
				rows.Close()
				return nil, fmt.Errorf("live keys in use: %w", err)
			}
			out[k] = true
		}
		if err := rows.Close(); err != nil {
			return nil, fmt.Errorf("live keys in use: %w", err)
		}
	}
	return out, nil
}

func (d *DB) SealedKeysInUse(ctx context.Context) (map[string]bool, error) {
	rows, err := d.r.query(ctx, "SELECT DISTINCT sealed_key FROM sessions WHERE deleted_at IS NULL AND sealed_key IS NOT NULL")
	if err != nil {
		return nil, fmt.Errorf("sealed keys in use: %w", err)
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var k string
		if err := rows.Scan(&k); err != nil {
			return nil, fmt.Errorf("sealed keys in use: %w", err)
		}
		out[k] = true
	}
	return out, rows.Err()
}

func (d *DB) ExpireSessions(ctx context.Context, now int64) (int, int64, error) {
	var deleted int
	var bytes int64
	err := d.tx(ctx, func(c conn) error {
		where := `FROM sessions s JOIN projects p ON p.id = s.project_id
			WHERE s.deleted_at IS NULL AND s.started_at < ? - p.retention_days * ` + dayMsSQL + ` AND NOT ` + keptCond
		var n int
		var b int64
		if err := c.row(ctx, "SELECT COUNT(*), CAST(COALESCE(SUM(s.size_bytes), 0) AS BIGINT) "+where, now).Scan(&n, &b); err != nil {
			return err
		}
		if n == 0 {
			return nil
		}
		deleted, bytes = n, b
		_, err := c.exec(ctx, "UPDATE sessions SET deleted_at = ? WHERE id IN (SELECT s.id "+where+")", now, now)
		return err
	})
	if err != nil {
		return 0, 0, fmt.Errorf("expire sessions: %w", err)
	}
	return deleted, bytes, nil
}

func (d *DB) PurgeDeleted(ctx context.Context, now int64) (int, error) {
	dropped := 0
	if d.pg() {
		n, err := d.dropDeadPartitions(ctx, now)
		if err != nil {
			return 0, err
		}
		dropped = n
	}
	var n int64
	err := d.tx(ctx, func(c conn) error {
		if _, err := c.exec(ctx, "DELETE FROM blocks WHERE session_id IN (SELECT id FROM sessions WHERE deleted_at IS NOT NULL)"); err != nil {
			return err
		}
		res, err := c.exec(ctx, "DELETE FROM sessions WHERE deleted_at IS NOT NULL")
		if err != nil {
			return err
		}
		n, err = res.RowsAffected()
		return err
	})
	if err != nil {
		return 0, fmt.Errorf("purge deleted sessions: %w", err)
	}
	return dropped + int(n), nil
}

// partitionName is the PostgreSQL partition holding sessions started on day.
func partitionName(day time.Time) string { return "sessions_p" + day.Format("20060102") }

func (d *DB) MaintainPartitions(ctx context.Context, now int64) error {
	if !d.pg() {
		return nil
	}
	today := time.UnixMilli(now).UTC().Truncate(24 * time.Hour)
	var errs []error
	for i := -1; i <= 7; i++ {
		day := today.AddDate(0, 0, i)
		from, to := day.UnixMilli(), day.AddDate(0, 0, 1).UnixMilli()
		_, err := d.w.exec(ctx, fmt.Sprintf("CREATE TABLE IF NOT EXISTS %s PARTITION OF sessions FOR VALUES FROM (%d) TO (%d)",
			partitionName(day), from, to))
		if err != nil {
			errs = append(errs, fmt.Errorf("create partition %s: %w", partitionName(day), err))
		}
	}
	return errors.Join(errs...)
}

// dropDeadPartitions drops day partitions older than every project's
// retention in which no live recording is left: the cheap way to delete a
// whole day at once. Returns how many rows went with them.
func (d *DB) dropDeadPartitions(ctx context.Context, now int64) (int, error) {
	var maxDays int
	if err := d.r.row(ctx, "SELECT COALESCE(MAX(retention_days), 365) FROM projects WHERE deleted_at IS NULL").Scan(&maxDays); err != nil {
		return 0, fmt.Errorf("max retention: %w", err)
	}
	cutoff := time.UnixMilli(now).UTC().AddDate(0, 0, -maxDays-1)
	rows, err := d.r.query(ctx, `SELECT c.relname FROM pg_inherits i
		JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent
		WHERE p.relname = 'sessions' AND c.relname LIKE 'sessions\_p%'`)
	if err != nil {
		return 0, fmt.Errorf("list partitions: %w", err)
	}
	var old []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			rows.Close()
			return 0, fmt.Errorf("list partitions: %w", err)
		}
		day, err := time.Parse("20060102", strings.TrimPrefix(name, "sessions_p"))
		if err == nil && day.Before(cutoff) {
			old = append(old, name)
		}
	}
	if err := rows.Close(); err != nil {
		return 0, fmt.Errorf("list partitions: %w", err)
	}
	total := 0
	for _, name := range old {
		err := d.tx(ctx, func(c conn) error {
			var alive, all int
			if err := c.row(ctx, "SELECT COUNT(*) FILTER (WHERE deleted_at IS NULL), COUNT(*) FROM "+name).Scan(&alive, &all); err != nil {
				return err
			}
			if alive > 0 {
				return nil
			}
			if _, err := c.exec(ctx, "DELETE FROM blocks WHERE session_id IN (SELECT id FROM "+name+")"); err != nil {
				return err
			}
			if _, err := c.exec(ctx, "DROP TABLE "+name); err != nil {
				return err
			}
			total += all
			return nil
		})
		if err != nil {
			return total, fmt.Errorf("drop partition %s: %w", name, err)
		}
	}
	return total, nil
}

var ageBuckets = []struct {
	label string
	days  int
}{{"Last 7 days", 7}, {"8–30 days", 30}, {"31–90 days", 90}, {"91–365 days", 365}, {"Older than a year", 0}}

func (d *DB) StorageReport(ctx context.Context, ids []string, now int64) (store.StorageReport, error) {
	rep := store.StorageReport{Projects: []store.ProjectStorage{}, Ages: make([]store.AgeBucket, len(ageBuckets))}
	for i, b := range ageBuckets {
		rep.Ages[i].Label = b.label
	}
	if len(ids) == 0 {
		return rep, nil
	}
	in := placeholders(len(ids))
	rows, err := d.r.query(ctx, `SELECT p.id, p.name, p.platform, p.retention_days, COUNT(s.id), CAST(COALESCE(SUM(s.size_bytes), 0) AS BIGINT)
		FROM projects p LEFT JOIN sessions s ON s.project_id = p.id AND s.deleted_at IS NULL
		WHERE p.id IN (`+in+`) AND p.deleted_at IS NULL
		GROUP BY p.id, p.name, p.platform, p.retention_days ORDER BY 6 DESC, p.name`, inArgs(ids)...)
	if err != nil {
		return rep, fmt.Errorf("storage by project: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var p store.ProjectStorage
		if err := rows.Scan(&p.ID, &p.Name, &p.Platform, &p.RetentionDays, &p.Recordings, &p.Bytes); err != nil {
			return rep, fmt.Errorf("storage by project: %w", err)
		}
		rep.Projects = append(rep.Projects, p)
		rep.TotalBytes += p.Bytes
		rep.Recordings += p.Recordings
	}
	if err := rows.Err(); err != nil {
		return rep, fmt.Errorf("storage by project: %w", err)
	}

	var bucket strings.Builder
	bucket.WriteString("CASE")
	args := []any{}
	for i, b := range ageBuckets[:len(ageBuckets)-1] {
		fmt.Fprintf(&bucket, " WHEN s.started_at >= ? THEN %d", i)
		args = append(args, now-int64(b.days)*store.DayMs)
	}
	fmt.Fprintf(&bucket, " ELSE %d END", len(ageBuckets)-1)
	args = append(args, now+7*store.DayMs)
	args = append(args, inArgs(ids)...)
	ages, err := d.r.query(ctx, `SELECT `+bucket.String()+` AS b, CAST(SUM(s.size_bytes) AS BIGINT),
			CAST(SUM(CASE WHEN s.started_at < ? - p.retention_days * `+dayMsSQL+` AND NOT `+keptCond+` THEN s.size_bytes ELSE 0 END) AS BIGINT)
		FROM sessions s JOIN projects p ON p.id = s.project_id
		WHERE s.deleted_at IS NULL AND s.project_id IN (`+in+`) GROUP BY b`, args...)
	if err != nil {
		return rep, fmt.Errorf("storage by age: %w", err)
	}
	defer ages.Close()
	for ages.Next() {
		var i int
		var b store.AgeBucket
		if err := ages.Scan(&i, &b.Bytes, &b.ExpiringBytes); err != nil {
			return rep, fmt.Errorf("storage by age: %w", err)
		}
		rep.Ages[i].Bytes, rep.Ages[i].ExpiringBytes = b.Bytes, b.ExpiringBytes
	}
	if err := ages.Err(); err != nil {
		return rep, fmt.Errorf("storage by age: %w", err)
	}

	err = d.r.row(ctx, `SELECT CAST(COALESCE(SUM(s.size_bytes), 0) AS BIGINT)
		FROM sessions s JOIN projects p ON p.id = s.project_id
		WHERE s.project_id IN (`+in+`) AND (s.deleted_at IS NOT NULL OR (s.started_at < ? - p.retention_days * `+dayMsSQL+` AND NOT `+keptCond+`))`,
		append(inArgs(ids), now)...).Scan(&rep.NextCleanupFreesBytes)
	if err != nil {
		return rep, fmt.Errorf("storage next cleanup: %w", err)
	}
	return rep, nil
}
