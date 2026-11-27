package api

import (
	"net/http"
	"strings"
	"time"

	"github.com/dimmihq/kimmi/internal/store"
)

func (a *API) listVisitors(w http.ResponseWriter, r *http.Request, _ *principal, proj store.Project) {
	q := r.URL.Query()
	page, err := a.Store.ListVisitors(r.Context(), store.VisitorQuery{
		ProjectID: proj.ID, Q: strings.TrimSpace(q.Get("q")), Kind: q.Get("kind"), Sort: q.Get("sort"),
		Page: intParam(r, "page", 0, 0, 1<<20), Limit: intParam(r, "limit", 25, 1, 100),
	})
	if err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": page.Items, "total": page.Total, "counts": page.Counts})
}

func (a *API) getVisitor(w http.ResponseWriter, r *http.Request, _ *principal, proj store.Project) {
	v, err := a.Store.GetVisitor(r.Context(), proj.ID, r.PathValue("vid"))
	if err != nil {
		a.fail(w, r, err)
		return
	}
	start, off := today(proj.Timezone, time.Now())
	stats, activity, err := a.Store.VisitorDetail(r.Context(), proj.ID, v.ID, start-83*store.DayMs, off)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	recs, err := a.Store.ListRecordings(r.Context(), store.RecordingQuery{ProjectID: proj.ID, VisitorID: v.ID, Limit: 50})
	if err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"visitor": v, "stats": stats, "activity": activity,
		"recordings": a.recordingViews(recs.Items)})
}

func (a *API) deleteVisitor(w http.ResponseWriter, r *http.Request, _ *principal, proj store.Project) {
	if err := a.Store.DeleteVisitor(r.Context(), proj.ID, r.PathValue("vid"), time.Now().UnixMilli()); err != nil {
		a.fail(w, r, err)
		return
	}
	noContent(w)
}

// eraseVisitors deletes every visitor matching an id, external id or email,
// with their recordings, and returns how many visitors went.
func (a *API) eraseVisitors(w http.ResponseWriter, r *http.Request, _ *principal, proj store.Project) {
	var in struct{ Query string }
	if err := decode(r, &in); err != nil {
		a.fail(w, r, err)
		return
	}
	if in.Query = strings.TrimSpace(in.Query); in.Query == "" {
		a.fail(w, r, invalid("Give a visitor id, external id or email", map[string]string{"query": "Required"}))
		return
	}
	ids, err := a.Store.FindVisitors(r.Context(), proj.ID, in.Query)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	now := time.Now().UnixMilli()
	for _, id := range ids {
		if err := a.Store.DeleteVisitor(r.Context(), proj.ID, id, now); err != nil {
			a.fail(w, r, err)
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]int{"deleted": len(ids)})
}
