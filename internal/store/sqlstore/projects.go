package sqlstore

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/dimmihq/kimmi/internal/store"
)

const projectCols = "id, org_id, name, slug, platform, origin, timezone, public_key, origins, settings, retention_days, keep_starred, created_at, deleted_at"

func scanProject(s interface{ Scan(...any) error }) (store.Project, error) {
	var p store.Project
	var origins, settings string
	err := s.Scan(&p.ID, &p.OrgID, &p.Name, &p.Slug, &p.Platform, &p.Origin, &p.Timezone, &p.PublicKey,
		&origins, &settings, &p.RetentionDays, &p.KeepStarred, &p.CreatedAt, &p.DeletedAt)
	if err != nil {
		return p, err
	}
	p.Settings = []byte(settings)
	if err := json.Unmarshal([]byte(origins), &p.Origins); err != nil {
		return p, fmt.Errorf("project %s origins: %w", p.ID, err)
	}
	if p.Origins == nil {
		p.Origins = []string{}
	}
	return p, nil
}

func jsonText(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

func originsText(o []string) string {
	if o == nil {
		o = []string{}
	}
	return jsonText(o)
}

func (d *DB) CreateProject(ctx context.Context, p store.Project) error {
	_, err := d.w.exec(ctx, "INSERT INTO projects ("+projectCols+") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		p.ID, p.OrgID, p.Name, p.Slug, p.Platform, p.Origin, p.Timezone, p.PublicKey,
		originsText(p.Origins), string(p.Settings), p.RetentionDays, p.KeepStarred, p.CreatedAt, p.DeletedAt)
	if isUnique(err) {
		return store.ErrConflict
	}
	if err != nil {
		return fmt.Errorf("create project: %w", err)
	}
	return nil
}

func (d *DB) GetProject(ctx context.Context, orgID, id string) (store.Project, error) {
	p, err := scanProject(d.r.row(ctx, "SELECT "+projectCols+" FROM projects WHERE id = ? AND org_id = ? AND deleted_at IS NULL", id, orgID))
	if err != nil {
		return p, fmt.Errorf("get project: %w", notFound(err))
	}
	return p, nil
}

func (d *DB) listProjects(ctx context.Context, where string, args ...any) ([]store.Project, error) {
	rows, err := d.r.query(ctx, "SELECT "+projectCols+" FROM projects WHERE deleted_at IS NULL"+where+" ORDER BY created_at", args...)
	if err != nil {
		return nil, fmt.Errorf("list projects: %w", err)
	}
	defer rows.Close()
	var out []store.Project
	for rows.Next() {
		p, err := scanProject(rows)
		if err != nil {
			return nil, fmt.Errorf("list projects: %w", err)
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (d *DB) ListProjects(ctx context.Context, orgID string) ([]store.Project, error) {
	return d.listProjects(ctx, " AND org_id = ?", orgID)
}

func (d *DB) ListAllProjects(ctx context.Context) ([]store.Project, error) {
	return d.listProjects(ctx, "")
}

func (d *DB) UpdateProject(ctx context.Context, p store.Project) error {
	err := mustAffect(d.w.exec(ctx, `UPDATE projects SET name = ?, slug = ?, platform = ?, origin = ?, timezone = ?, public_key = ?,
		origins = ?, settings = ?, retention_days = ?, keep_starred = ? WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
		p.Name, p.Slug, p.Platform, p.Origin, p.Timezone, p.PublicKey, originsText(p.Origins), string(p.Settings),
		p.RetentionDays, p.KeepStarred, p.ID, p.OrgID))
	if isUnique(err) {
		return store.ErrConflict
	}
	if err != nil {
		return fmt.Errorf("update project: %w", err)
	}
	return nil
}

func (d *DB) DeleteProject(ctx context.Context, orgID, id string, at int64) error {
	err := d.tx(ctx, func(c conn) error {
		if err := mustAffect(c.exec(ctx, "UPDATE projects SET deleted_at = ? WHERE id = ? AND org_id = ? AND deleted_at IS NULL", at, id, orgID)); err != nil {
			return err
		}
		if _, err := c.exec(ctx, "UPDATE sessions SET deleted_at = ? WHERE project_id = ? AND deleted_at IS NULL", at, id); err != nil {
			return err
		}
		if _, err := c.exec(ctx, "DELETE FROM blocks WHERE project_id = ?", id); err != nil {
			return err
		}
		if err := deleteProjectAnalytics(ctx, c, id); err != nil {
			return err
		}
		_, err := c.exec(ctx, "DELETE FROM project_members WHERE project_id = ?", id)
		return err
	})
	if err != nil {
		return fmt.Errorf("delete project: %w", err)
	}
	return nil
}

func (d *DB) ProjectStats(ctx context.Context, ids []string, q store.StatsQuery) (map[string]store.ProjectStats, error) {
	out := make(map[string]store.ProjectStats, len(ids))
	for _, id := range ids {
		out[id] = store.ProjectStats{Series: make([]int, 30)}
	}
	if len(ids) == 0 {
		return out, nil
	}
	in := placeholders(len(ids))
	args := append([]any{q.Now - store.DayMs, q.LiveSince}, inArgs(ids)...)
	rows, err := d.r.query(ctx, `SELECT project_id, COUNT(*),
			SUM(CASE WHEN started_at >= ? THEN 1 ELSE 0 END),
			SUM(CASE WHEN sealed = FALSE AND last_at >= ? THEN 1 ELSE 0 END),
			CAST(COALESCE(AVG(duration_ms), 0) AS BIGINT),
			CAST(COALESCE(SUM(size_bytes), 0) AS BIGINT),
			MAX(started_at)
		FROM sessions WHERE deleted_at IS NULL AND project_id IN (`+in+`) GROUP BY project_id`, args...)
	if err != nil {
		return nil, fmt.Errorf("project stats: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var s store.ProjectStats
		if err := rows.Scan(&id, &s.Recordings, &s.Recordings24h, &s.Live, &s.AvgDurationMs, &s.StorageBytes, &s.LastRecordingAt); err != nil {
			return nil, fmt.Errorf("project stats: %w", err)
		}
		s.Series = out[id].Series
		out[id] = s
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("project stats: %w", err)
	}

	today := (q.Now + q.DayOffsetMs) / store.DayMs
	first := today - 29
	args = append([]any{q.DayOffsetMs}, inArgs(ids)...)
	args = append(args, first*store.DayMs-q.DayOffsetMs)
	series, err := d.r.query(ctx, `SELECT project_id, (started_at + ?) / 86400000 AS d, COUNT(*)
		FROM sessions WHERE deleted_at IS NULL AND project_id IN (`+in+`) AND started_at >= ?
		GROUP BY project_id, d`, args...)
	if err != nil {
		return nil, fmt.Errorf("project series: %w", err)
	}
	defer series.Close()
	for series.Next() {
		var id string
		var day int64
		var n int
		if err := series.Scan(&id, &day, &n); err != nil {
			return nil, fmt.Errorf("project series: %w", err)
		}
		if i := day - first; i >= 0 && i < 30 {
			out[id].Series[i] = n
		}
	}
	return out, series.Err()
}

func (d *DB) ListProjectMembers(ctx context.Context, projectID string) ([]store.ProjectMember, error) {
	rows, err := d.r.query(ctx, `SELECT u.id, u.name, u.email, m.role,
			(SELECT MAX(a.last_seen_at) FROM auth_sessions a WHERE a.user_id = u.id)
		FROM project_members m JOIN users u ON u.id = m.user_id
		WHERE m.project_id = ? ORDER BY u.name`, projectID)
	if err != nil {
		return nil, fmt.Errorf("list project members: %w", err)
	}
	defer rows.Close()
	out := []store.ProjectMember{}
	for rows.Next() {
		var m store.ProjectMember
		if err := rows.Scan(&m.UserID, &m.Name, &m.Email, &m.Role, &m.LastActiveAt); err != nil {
			return nil, fmt.Errorf("list project members: %w", err)
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func (d *DB) ProjectRoles(ctx context.Context, userID string) (map[string]string, error) {
	rows, err := d.r.query(ctx, "SELECT project_id, role FROM project_members WHERE user_id = ?", userID)
	if err != nil {
		return nil, fmt.Errorf("project roles: %w", err)
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var p, r string
		if err := rows.Scan(&p, &r); err != nil {
			return nil, fmt.Errorf("project roles: %w", err)
		}
		out[p] = r
	}
	return out, rows.Err()
}

func (d *DB) PutProjectMember(ctx context.Context, projectID, userID, role string) error {
	_, err := d.w.exec(ctx, `INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)
		ON CONFLICT (project_id, user_id) DO UPDATE SET role = excluded.role`, projectID, userID, role)
	if err != nil {
		return fmt.Errorf("put project member: %w", err)
	}
	return nil
}

func (d *DB) DeleteProjectMember(ctx context.Context, projectID, userID string) error {
	if err := mustAffect(d.w.exec(ctx, "DELETE FROM project_members WHERE project_id = ? AND user_id = ?", projectID, userID)); err != nil {
		return fmt.Errorf("delete project member: %w", err)
	}
	return nil
}
