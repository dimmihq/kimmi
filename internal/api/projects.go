package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/dimmihq/kimmi/internal/auth"
	"github.com/dimmihq/kimmi/internal/project"
	"github.com/dimmihq/kimmi/internal/settings"
	"github.com/dimmihq/kimmi/internal/store"
)

var platforms = project.Platforms

type projectView struct {
	ID            string   `json:"id"`
	Name          string   `json:"name"`
	Slug          string   `json:"slug"`
	Platform      string   `json:"platform"`
	Origin        string   `json:"origin"`
	Timezone      string   `json:"timezone"`
	PublicKey     string   `json:"publicKey"`
	Origins       []string `json:"origins"`
	RetentionDays int      `json:"retentionDays"`
	CreatedAt     int64    `json:"createdAt"`
	// Analytics says visit counting is on: the dashboard shows the
	// analytics pages only then.
	Analytics bool               `json:"analytics"`
	Stats     store.ProjectStats `json:"stats"`
}

// dayOffset is how far the project's time zone is ahead of UTC right now, so
// daily buckets follow the project's calendar.
func dayOffset(tz string) int64 {
	loc, err := time.LoadLocation(tz)
	if err != nil {
		return 0
	}
	_, off := time.Now().In(loc).Zone()
	return int64(off) * 1000
}

// views attaches stats to projects; one query set per distinct time zone offset.
func (a *API) views(r *http.Request, projects []store.Project) ([]projectView, error) {
	now := time.Now().UnixMilli()
	byOffset := map[int64][]string{}
	for _, p := range projects {
		off := dayOffset(p.Timezone)
		byOffset[off] = append(byOffset[off], p.ID)
	}
	stats := map[string]store.ProjectStats{}
	for off, ids := range byOffset {
		s, err := a.Store.ProjectStats(r.Context(), ids, store.StatsQuery{Now: now, LiveSince: now - a.Config.LiveWindow.Milliseconds(), DayOffsetMs: off})
		if err != nil {
			return nil, err
		}
		for id, st := range s {
			stats[id] = st
		}
	}
	out := make([]projectView, len(projects))
	for i, p := range projects {
		out[i] = projectView{ID: p.ID, Name: p.Name, Slug: p.Slug, Platform: p.Platform, Origin: p.Origin, Timezone: p.Timezone,
			PublicKey: p.PublicKey, Origins: p.Origins, RetentionDays: p.RetentionDays, CreatedAt: p.CreatedAt,
			Analytics: projectSettings(p).Analytics.Enabled, Stats: stats[p.ID]}
	}
	return out, nil
}

func (a *API) writeProject(w http.ResponseWriter, r *http.Request, status int, p store.Project) {
	views, err := a.views(r, []store.Project{p})
	if err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, status, views[0])
}

// visibleProjects lists the projects the caller may see.
func (a *API) visibleProjects(r *http.Request, p *principal) ([]store.Project, error) {
	all, err := a.Store.ListProjects(r.Context(), p.user.OrgID)
	if err != nil || auth.AtLeast(p.user.Role, store.RoleAdmin) {
		return all, err
	}
	roles, err := a.Store.ProjectRoles(r.Context(), p.user.ID)
	if err != nil {
		return nil, err
	}
	return slices.DeleteFunc(all, func(pr store.Project) bool { _, ok := roles[pr.ID]; return !ok }), nil
}

func (a *API) listProjects(w http.ResponseWriter, r *http.Request, p *principal) {
	projects, err := a.visibleProjects(r, p)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	views, err := a.views(r, projects)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, views)
}

func validOrigin(o string) bool { return project.ValidOrigin(o) }

func (a *API) createProject(w http.ResponseWriter, r *http.Request, p *principal) {
	var in struct{ Name, Origin, Platform string }
	if err := decode(r, &in); err != nil {
		a.fail(w, r, err)
		return
	}
	proj, fields := project.Build(p.user.OrgID, project.Spec{Name: in.Name, Origin: in.Origin, Platform: in.Platform})
	if len(fields) > 0 {
		a.fail(w, r, invalid("Check the highlighted fields", fields))
		return
	}
	proj, err := project.Create(r.Context(), a.Store, proj)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	a.Projects.Invalidate(r.Context())
	a.writeProject(w, r, http.StatusCreated, proj)
}

func (a *API) getProject(w http.ResponseWriter, r *http.Request, _ *principal, proj store.Project) {
	a.writeProject(w, r, http.StatusOK, proj)
}

// saveProject stores proj, tells ingest, and answers with the result.
func (a *API) saveProject(w http.ResponseWriter, r *http.Request, proj store.Project) {
	if err := a.Store.UpdateProject(r.Context(), proj); err != nil {
		if errors.Is(err, store.ErrConflict) {
			err = &apiError{status: http.StatusConflict, code: "conflict", msg: "Another project already uses this slug",
				fields: map[string]string{"slug": "Already in use"}}
		}
		a.fail(w, r, err)
		return
	}
	a.Projects.Invalidate(r.Context())
	a.writeProject(w, r, http.StatusOK, proj)
}

func (a *API) updateProject(w http.ResponseWriter, r *http.Request, _ *principal, proj store.Project) {
	var in struct{ Name, Slug, Timezone, Platform, Origin *string }
	if err := decode(r, &in); err != nil {
		a.fail(w, r, err)
		return
	}
	fields := map[string]string{}
	if in.Name != nil {
		if proj.Name = strings.TrimSpace(*in.Name); proj.Name == "" {
			fields["name"] = "Required"
		}
	}
	if in.Slug != nil {
		if proj.Slug = *in.Slug; !project.ValidSlug(proj.Slug) {
			fields["slug"] = "Lowercase letters, digits and dashes"
		}
	}
	if in.Timezone != nil {
		proj.Timezone = *in.Timezone
		if _, err := time.LoadLocation(proj.Timezone); err != nil || proj.Timezone == "" || proj.Timezone == "Local" {
			fields["timezone"] = "An IANA time zone like Europe/London"
		}
	}
	if in.Platform != nil {
		if proj.Platform = *in.Platform; !slices.Contains(platforms, proj.Platform) {
			fields["platform"] = "Must be one of " + strings.Join(platforms, ", ")
		}
	}
	if in.Origin != nil {
		if proj.Origin = strings.TrimRight(strings.TrimSpace(*in.Origin), "/"); !validOrigin(proj.Origin) {
			fields["origin"] = "A site address like https://acme.dev"
		}
	}
	if len(fields) > 0 {
		a.fail(w, r, invalid("Check the highlighted fields", fields))
		return
	}
	a.saveProject(w, r, proj)
}

func (a *API) deleteProject(w http.ResponseWriter, r *http.Request, _ *principal, proj store.Project) {
	if err := a.Store.DeleteProject(r.Context(), proj.OrgID, proj.ID, time.Now().UnixMilli()); err != nil {
		a.fail(w, r, err)
		return
	}
	a.Projects.Invalidate(r.Context())
	noContent(w)
}

func (a *API) rotateKey(w http.ResponseWriter, r *http.Request, _ *principal, proj store.Project) {
	proj.PublicKey = auth.NewPublicKey()
	a.saveProject(w, r, proj)
}

func (a *API) putOrigins(w http.ResponseWriter, r *http.Request, _ *principal, proj store.Project) {
	var in struct{ Origins []string }
	if err := decode(r, &in); err != nil {
		a.fail(w, r, err)
		return
	}
	fields := map[string]string{}
	origins := []string{}
	for i, o := range in.Origins {
		o = strings.TrimRight(strings.TrimSpace(o), "/")
		if !project.ValidOriginPattern(o) {
			fields[fmt.Sprintf("origins.%d", i)] = "An origin like https://acme.dev or https://*.acme.dev"
		}
		if !slices.Contains(origins, o) {
			origins = append(origins, o)
		}
	}
	if len(fields) > 0 {
		a.fail(w, r, invalid("Check the highlighted origins", fields))
		return
	}
	proj.Origins = origins
	a.saveProject(w, r, proj)
}

func projectSettings(p store.Project) settings.Settings {
	return settings.Decode(p.Settings, p.RetentionDays, p.KeepStarred)
}

// getSettings shows the webhook, which can carry a secret, to admins only.
func (a *API) getSettings(w http.ResponseWriter, r *http.Request, p *principal, proj store.Project) {
	s := projectSettings(proj)
	if role, err := a.projectRole(r, p, proj.ID); err != nil || !auth.AtLeast(role, store.RoleAdmin) {
		if s.Alerts.WebhookURL != "" {
			s.Alerts.WebhookURL = "hidden"
		}
		s.Alerts.Secret = ""
	}
	writeJSON(w, http.StatusOK, s)
}

func (a *API) patchSettings(w http.ResponseWriter, r *http.Request, _ *principal, proj store.Project) {
	var patch json.RawMessage
	if err := decode(r, &patch); err != nil {
		a.fail(w, r, err)
		return
	}
	next, fields, err := projectSettings(proj).Merge(patch)
	if err != nil {
		a.fail(w, r, invalid(err.Error(), nil))
		return
	}
	if fields != nil {
		a.fail(w, r, invalid("Check the highlighted settings", fields))
		return
	}
	changed, gone := changedFunnels(projectSettings(proj).Analytics.Funnels, &next.Analytics.Funnels)
	proj.Settings, proj.RetentionDays, proj.KeepStarred = next.Encode(), next.Retention.Days, next.Retention.KeepStarred
	if err := a.Store.UpdateProject(r.Context(), proj); err != nil {
		a.fail(w, r, err)
		return
	}
	a.Projects.Invalidate(r.Context())
	a.countFunnels(proj.ID, changed, gone)
	writeJSON(w, http.StatusOK, next)
}

func (a *API) listProjectMembers(w http.ResponseWriter, r *http.Request, _ *principal, proj store.Project) {
	members, err := a.Store.ListProjectMembers(r.Context(), proj.ID)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, members)
}

// putProjectMember gives a user of the org a role in the project.
func (a *API) putProjectMember(w http.ResponseWriter, r *http.Request, proj store.Project, userID, role string, status int) {
	if !auth.ValidRole(role) || role == store.RoleOwner {
		a.fail(w, r, invalid("Unknown project role", map[string]string{"role": "Must be admin, member or viewer"}))
		return
	}
	u, err := a.Store.GetUser(r.Context(), userID)
	if err != nil || u.OrgID != proj.OrgID {
		a.fail(w, r, invalid("No such member in this workspace", map[string]string{"userId": "Unknown member"}))
		return
	}
	if err := a.Store.PutProjectMember(r.Context(), proj.ID, u.ID, role); err != nil {
		a.fail(w, r, err)
		return
	}
	members, err := a.Store.ListProjectMembers(r.Context(), proj.ID)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	for _, m := range members {
		if m.UserID == u.ID {
			writeJSON(w, status, m)
			return
		}
	}
	a.fail(w, r, errNotFound)
}

func (a *API) addProjectMember(w http.ResponseWriter, r *http.Request, _ *principal, proj store.Project) {
	var in struct{ UserID, Role string }
	if err := decode(r, &in); err != nil {
		a.fail(w, r, err)
		return
	}
	a.putProjectMember(w, r, proj, in.UserID, in.Role, http.StatusCreated)
}

func (a *API) updateProjectMember(w http.ResponseWriter, r *http.Request, _ *principal, proj store.Project) {
	var in struct{ Role string }
	if err := decode(r, &in); err != nil {
		a.fail(w, r, err)
		return
	}
	roles, err := a.Store.ProjectRoles(r.Context(), r.PathValue("userId"))
	if err != nil {
		a.fail(w, r, err)
		return
	}
	if _, ok := roles[proj.ID]; !ok {
		a.fail(w, r, errNotFound)
		return
	}
	a.putProjectMember(w, r, proj, r.PathValue("userId"), in.Role, http.StatusOK)
}

func (a *API) deleteProjectMember(w http.ResponseWriter, r *http.Request, _ *principal, proj store.Project) {
	if err := a.Store.DeleteProjectMember(r.Context(), proj.ID, r.PathValue("userId")); err != nil {
		a.fail(w, r, err)
		return
	}
	noContent(w)
}

func (a *API) deleteRecordings(w http.ResponseWriter, r *http.Request, _ *principal, proj store.Project) {
	var in struct{ OlderThanDays *int }
	if err := decode(r, &in); err != nil {
		a.fail(w, r, err)
		return
	}
	now := time.Now().UnixMilli()
	var before int64
	if in.OlderThanDays != nil {
		if *in.OlderThanDays < 0 {
			a.fail(w, r, invalid("olderThanDays must not be negative", map[string]string{"olderThanDays": "Must be 0 or more"}))
			return
		}
		before = now - int64(*in.OlderThanDays)*store.DayMs
	}
	n, err := a.Store.DeleteRecordings(r.Context(), proj.ID, before, now)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]int{"deleted": n})
}

// changedFunnels compares the funnels before and after a settings change.
// A funnel whose steps changed is another funnel: it gets a new id, so the
// counts kept under the old one are not mixed with it. It returns the
// funnels to count over the stored visits and the ids to forget.
func changedFunnels(before []settings.Funnel, after *[]settings.Funnel) (count []store.Funnel, gone []string) {
	old := map[string]settings.Funnel{}
	for _, f := range before {
		old[f.ID] = f
	}
	kept := map[string]bool{}
	for i := range *after {
		f := &(*after)[i]
		was, existed := old[f.ID]
		if existed && slices.Equal(was.Steps, f.Steps) {
			kept[f.ID] = true
			continue
		}
		if existed {
			f.ID = settings.NewID()
		}
		steps := make([]store.Step, len(f.Steps))
		for j, st := range f.Steps {
			steps[j] = step(st)
		}
		count = append(count, store.Funnel{ID: f.ID, Steps: steps})
	}
	for id := range old {
		if !kept[id] {
			gone = append(gone, id)
		}
	}
	return count, gone
}

// countFunnels counts new funnels over the visits already stored and
// forgets removed ones, after the answer has gone out: with months of
// events it takes a moment, and the funnel fills in when it is done.
func (a *API) countFunnels(projectID string, count []store.Funnel, gone []string) {
	if len(count) == 0 && len(gone) == 0 {
		return
	}
	a.background.Add(1)
	go func() {
		defer a.background.Done()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		defer cancel()
		for _, id := range gone {
			if err := a.Store.BackfillFunnel(ctx, projectID, store.Funnel{ID: id}); err != nil {
				a.Log.Error("forget funnel", "project", projectID, "err", err)
			}
		}
		for _, f := range count {
			if err := a.Store.BackfillFunnel(ctx, projectID, f); err != nil {
				a.Log.Error("count funnel", "project", projectID, "funnel", f.ID, "err", err)
			}
		}
	}()
}

// Wait returns once the work started in the background by earlier requests
// is done. Tests use it; a server shutting down may too.
func (a *API) Wait() { a.background.Wait() }
