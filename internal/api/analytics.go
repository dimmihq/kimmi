package api

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/dimmihq/kimmi/internal/auth"
	"github.com/dimmihq/kimmi/internal/notify"
	"github.com/dimmihq/kimmi/internal/replay"
	"github.com/dimmihq/kimmi/internal/settings"
	"github.com/dimmihq/kimmi/internal/store"
)

func (a *API) analyticsRoutes(m *http.ServeMux, p string) {
	m.HandleFunc("GET "+p+"/analytics", a.project(store.RoleViewer, a.traffic))
	m.HandleFunc("GET "+p+"/events", a.project(store.RoleViewer, a.eventNames))
	m.HandleFunc("GET "+p+"/errors", a.project(store.RoleViewer, a.errorGroups))
	m.HandleFunc("GET "+p+"/errors/{fingerprint}", a.project(store.RoleViewer, a.errorGroup))
	m.HandleFunc("GET "+p+"/friction", a.project(store.RoleViewer, a.friction))
	m.HandleFunc("GET "+p+"/requests", a.project(store.RoleViewer, a.requests))
	m.HandleFunc("GET "+p+"/vitals", a.project(store.RoleViewer, a.vitals))
	m.HandleFunc("GET "+p+"/funnels", a.project(store.RoleViewer, a.funnels))
	m.HandleFunc("GET "+p+"/funnels/{fid}/dropoffs", a.project(store.RoleViewer, a.funnelDropoffs))
	m.HandleFunc("GET "+p+"/heatmaps", a.project(store.RoleViewer, a.heatmapPages))
	m.HandleFunc("GET "+p+"/heatmap", a.project(store.RoleViewer, a.heatmap))
	m.HandleFunc("GET "+p+"/retention", a.project(store.RoleViewer, a.retention))
	m.HandleFunc("GET "+p+"/releases", a.project(store.RoleViewer, a.releases))
	m.HandleFunc("GET "+p+"/accounts", a.project(store.RoleViewer, a.accounts))

	m.HandleFunc("GET "+p+"/recordings/{rid}/notes", a.project(store.RoleViewer, a.listNotes))
	m.HandleFunc("POST "+p+"/recordings/{rid}/notes", a.project(store.RoleMember, a.createNote))
	m.HandleFunc("DELETE "+p+"/recordings/{rid}/notes/{nid}", a.project(store.RoleMember, a.deleteNote))

	m.HandleFunc("GET "+p+"/shares", a.project(store.RoleAdmin, a.listShares))
	m.HandleFunc("POST "+p+"/shares", a.project(store.RoleAdmin, a.createShare))
	m.HandleFunc("DELETE "+p+"/shares/{sid}", a.project(store.RoleAdmin, a.deleteShare))

	m.HandleFunc("GET "+p+"/feedback", a.project(store.RoleViewer, a.listFeedback))
	m.HandleFunc("PATCH "+p+"/feedback/{fid}", a.project(store.RoleMember, a.patchFeedback))
	m.HandleFunc("DELETE "+p+"/feedback/{fid}", a.project(store.RoleMember, a.deleteFeedback))

	m.HandleFunc("POST "+p+"/alerts/test", a.project(store.RoleAdmin, a.testWebhook))
	m.HandleFunc("POST "+p+"/alerts/digest", a.project(store.RoleAdmin, a.sendDigest))

	if a.Config.TestHooks {
		m.HandleFunc("POST /api/v1/test/clock", a.user(store.RoleOwner, a.testClock))
	}

	const shared = "/api/v1/shared/{token}"
	m.HandleFunc("GET "+shared, a.sharedLink)
	m.HandleFunc("GET "+shared+"/events", a.sharedEvents)
	m.HandleFunc("GET "+shared+"/analytics", a.sharedAnalytics)
}

// analyticsQuery reads ?days= (1, 7, 14, 30 or 90; 7 when missing) and the
// visit filters. The window ends now and starts at a day boundary of the
// project's time zone.
func analyticsQuery(r *http.Request, proj store.Project) store.AnalyticsQuery {
	q := r.URL.Query()
	days := 7
	switch q.Get("days") {
	case "1":
		days = 1
	case "14":
		days = 14
	case "30":
		days = 30
	case "90":
		days = 90
	}
	now := time.Now()
	start, off := today(proj.Timezone, now)
	from := start - int64(days-1)*store.DayMs
	return store.AnalyticsQuery{ProjectID: proj.ID, From: from, To: now.UnixMilli() + 1, PrevFrom: from - int64(days)*store.DayMs,
		DayOffsetMs: off, Filter: store.VisitFilter{
			Path: q.Get("path"), Entry: q.Get("entry"), Exit: q.Get("exit"), Referrer: q.Get("referrer"), Channel: q.Get("channel"),
			UTMSource: q.Get("utmSource"), UTMCampaign: q.Get("utmCampaign"), Country: q.Get("country"), Device: q.Get("device"),
			Browser: q.Get("browser"), OS: q.Get("os"), Language: q.Get("language"),
		}}
}

type goalView struct {
	settings.Goal
	Conversions int `json:"conversions"`
}

type trafficView struct {
	store.Traffic
	Goals []goalView `json:"goals"`
	// GoalSources splits the goal named by ?goal= by where its visits came from.
	GoalSources []store.NameCount `json:"goalSources"`
}

func step(s settings.Step) store.Step { return store.Step{Kind: s.Kind, Value: s.Value} }

func (a *API) trafficView(r *http.Request, proj store.Project) (trafficView, error) {
	q := analyticsQuery(r, proj)
	t, err := a.Store.Traffic(r.Context(), q)
	if err != nil {
		return trafficView{}, err
	}
	out := trafficView{Traffic: t, Goals: []goalView{}, GoalSources: []store.NameCount{}}
	goals := projectSettings(proj).Analytics.Goals
	if len(goals) == 0 {
		return out, nil
	}
	steps := make([]store.Step, len(goals))
	for i, g := range goals {
		steps[i] = step(g.Step)
	}
	counts, err := a.Store.Goals(r.Context(), q, steps)
	if err != nil {
		return out, err
	}
	for i, g := range goals {
		out.Goals = append(out.Goals, goalView{g, counts[i]})
		if g.ID == r.URL.Query().Get("goal") {
			if out.GoalSources, err = a.Store.GoalSources(r.Context(), q, steps[i]); err != nil {
				return out, err
			}
		}
	}
	return out, nil
}

func (a *API) traffic(w http.ResponseWriter, r *http.Request, _ *principal, proj store.Project) {
	out, err := a.trafficView(r, proj)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// answer writes a store read as JSON.
func answer[T any](a *API, w http.ResponseWriter, r *http.Request, v T, err error) {
	if err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, v)
}

func (a *API) eventNames(w http.ResponseWriter, r *http.Request, _ *principal, proj store.Project) {
	v, err := a.Store.EventNames(r.Context(), analyticsQuery(r, proj))
	answer(a, w, r, v, err)
}

func (a *API) errorGroups(w http.ResponseWriter, r *http.Request, _ *principal, proj store.Project) {
	v, err := a.Store.ErrorGroups(r.Context(), analyticsQuery(r, proj))
	answer(a, w, r, v, err)
}

func (a *API) errorGroup(w http.ResponseWriter, r *http.Request, _ *principal, proj store.Project) {
	g, occurrences, err := a.Store.ErrorGroup(r.Context(), analyticsQuery(r, proj), r.PathValue("fingerprint"))
	answer(a, w, r, map[string]any{"group": g, "occurrences": occurrences}, err)
}

func (a *API) friction(w http.ResponseWriter, r *http.Request, _ *principal, proj store.Project) {
	v, err := a.Store.Friction(r.Context(), analyticsQuery(r, proj))
	answer(a, w, r, v, err)
}

func (a *API) requests(w http.ResponseWriter, r *http.Request, _ *principal, proj store.Project) {
	v, err := a.Store.Requests(r.Context(), analyticsQuery(r, proj))
	answer(a, w, r, v, err)
}

func (a *API) vitals(w http.ResponseWriter, r *http.Request, _ *principal, proj store.Project) {
	v, err := a.Store.Vitals(r.Context(), analyticsQuery(r, proj))
	answer(a, w, r, v, err)
}

type funnelStepView struct {
	settings.Step
	Visits int `json:"visits"`
	// Dropped is how many visits stopped after this step, and Watchable how
	// many of them the dropoffs route can show (at most 200 are kept).
	Dropped   int `json:"dropped"`
	Watchable int `json:"watchable"`
}

type funnelView struct {
	ID    string           `json:"id"`
	Name  string           `json:"name"`
	Steps []funnelStepView `json:"steps"`
}

func (a *API) runFunnel(r *http.Request, proj store.Project, f settings.Funnel) (funnelView, []store.FunnelStep, error) {
	steps := make([]store.Step, len(f.Steps))
	for i, s := range f.Steps {
		steps[i] = step(s)
	}
	res, err := a.Store.Funnel(r.Context(), analyticsQuery(r, proj), steps)
	if err != nil {
		return funnelView{}, nil, err
	}
	view := funnelView{ID: f.ID, Name: f.Name, Steps: make([]funnelStepView, len(f.Steps))}
	for i, s := range f.Steps {
		view.Steps[i] = funnelStepView{Step: s, Visits: res[i].Visits, Watchable: len(res[i].Dropped)}
		if i+1 < len(res) {
			view.Steps[i].Dropped = res[i].Visits - res[i+1].Visits
		}
	}
	return view, res, nil
}

func (a *API) funnels(w http.ResponseWriter, r *http.Request, _ *principal, proj store.Project) {
	out := []funnelView{}
	for _, f := range projectSettings(proj).Analytics.Funnels {
		view, _, err := a.runFunnel(r, proj, f)
		if err != nil {
			a.fail(w, r, err)
			return
		}
		out = append(out, view)
	}
	writeJSON(w, http.StatusOK, out)
}

// funnelDropoffs lists the recordings of visits that reached ?step= (0 is
// the first) and went no further.
func (a *API) funnelDropoffs(w http.ResponseWriter, r *http.Request, _ *principal, proj store.Project) {
	for _, f := range projectSettings(proj).Analytics.Funnels {
		if f.ID != r.PathValue("fid") {
			continue
		}
		at := intParam(r, "step", 0, 0, len(f.Steps)-1)
		_, res, err := a.runFunnel(r, proj, f)
		if err != nil {
			a.fail(w, r, err)
			return
		}
		list, err := a.Store.RecordingsByID(r.Context(), proj.ID, res[at].Dropped)
		if err != nil {
			a.fail(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"items": a.recordingViews(list), "visits": len(res[at].Dropped)})
		return
	}
	a.fail(w, r, errNotFound)
}

func (a *API) heatmapPages(w http.ResponseWriter, r *http.Request, _ *principal, proj store.Project) {
	v, err := a.Store.HeatmapPages(r.Context(), analyticsQuery(r, proj))
	answer(a, w, r, v, err)
}

func (a *API) heatmap(w http.ResponseWriter, r *http.Request, _ *principal, proj store.Project) {
	q := analyticsQuery(r, proj)
	path := r.URL.Query().Get("path")
	if path == "" {
		a.fail(w, r, invalid("Choose a page", map[string]string{"path": "Required"}))
		return
	}
	device := r.URL.Query().Get("device")
	if device != "Desktop" && device != "Tablet" && device != "Mobile" {
		device = ""
	}
	v, err := a.Store.Heatmap(r.Context(), store.HeatmapQuery{ProjectID: proj.ID, From: q.From, To: q.To, Path: path, Device: device})
	answer(a, w, r, v, err)
}

func (a *API) retention(w http.ResponseWriter, r *http.Request, _ *principal, proj store.Project) {
	v, err := a.Store.Retention(r.Context(), store.RetentionQuery{ProjectID: proj.ID, Now: time.Now().UnixMilli(),
		DayOffsetMs: dayOffset(proj.Timezone), Weeks: 8})
	answer(a, w, r, v, err)
}

func (a *API) releases(w http.ResponseWriter, r *http.Request, _ *principal, proj store.Project) {
	v, err := a.Store.Releases(r.Context(), analyticsQuery(r, proj))
	answer(a, w, r, v, err)
}

func (a *API) accounts(w http.ResponseWriter, r *http.Request, _ *principal, proj store.Project) {
	v, err := a.Store.Accounts(r.Context(), proj.ID)
	answer(a, w, r, v, err)
}

// Notes.

func (a *API) listNotes(w http.ResponseWriter, r *http.Request, _ *principal, proj store.Project) {
	v, err := a.Store.ListNotes(r.Context(), proj.ID, r.PathValue("rid"))
	answer(a, w, r, v, err)
}

func (a *API) createNote(w http.ResponseWriter, r *http.Request, p *principal, proj store.Project) {
	var in struct {
		AtMs int64  `json:"atMs"`
		Body string `json:"body"`
	}
	if err := decode(r, &in); err != nil {
		a.fail(w, r, err)
		return
	}
	in.Body = strings.TrimSpace(in.Body)
	if in.Body == "" || len(in.Body) > 2000 {
		a.fail(w, r, invalid("Write a note of at most 2000 characters", map[string]string{"body": "Required, at most 2000 characters"}))
		return
	}
	rec, err := a.Store.GetRecording(r.Context(), proj.ID, r.PathValue("rid"))
	if err != nil {
		a.fail(w, r, err)
		return
	}
	n := store.Note{ID: store.NewID(), OrgID: proj.OrgID, ProjectID: proj.ID, SessionID: rec.ID, UserID: p.user.ID, Author: p.user.Name,
		AtMs: max(in.AtMs, 0), Body: in.Body, CreatedAt: time.Now().UnixMilli()}
	if err := a.Store.CreateNote(r.Context(), n); err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, n)
}

func (a *API) deleteNote(w http.ResponseWriter, r *http.Request, _ *principal, proj store.Project) {
	if err := a.Store.DeleteNote(r.Context(), proj.ID, r.PathValue("nid")); err != nil {
		a.fail(w, r, err)
		return
	}
	noContent(w)
}

// Share links.

type shareView struct {
	store.Share
	// Link is only known when the share is created: the token is not stored.
	Link string `json:"link,omitempty"`
}

func (a *API) listShares(w http.ResponseWriter, r *http.Request, _ *principal, proj store.Project) {
	v, err := a.Store.ListShares(r.Context(), proj.ID, time.Now().UnixMilli())
	answer(a, w, r, v, err)
}

func (a *API) createShare(w http.ResponseWriter, r *http.Request, p *principal, proj store.Project) {
	var in struct {
		Kind          string `json:"kind"`
		RecordingID   string `json:"recordingId"`
		StartMs       int64  `json:"startMs"`
		ExpiresInDays int    `json:"expiresInDays"`
	}
	if err := decode(r, &in); err != nil {
		a.fail(w, r, err)
		return
	}
	if !projectSettings(proj).Sharing.Enabled {
		a.fail(w, r, forbidden("Public links are turned off for this project"))
		return
	}
	if in.ExpiresInDays != 1 && in.ExpiresInDays != 7 && in.ExpiresInDays != 30 {
		a.fail(w, r, invalid("Choose when the link expires", map[string]string{"expiresInDays": "Must be 1, 7 or 30"}))
		return
	}
	now := time.Now()
	sh := store.Share{ID: store.NewID(), OrgID: proj.OrgID, ProjectID: proj.ID, Kind: in.Kind, CreatedBy: p.user.ID, Author: p.user.Name,
		CreatedAt: now.UnixMilli(), ExpiresAt: now.Add(time.Duration(in.ExpiresInDays) * 24 * time.Hour).UnixMilli()}
	switch in.Kind {
	case store.ShareRecording:
		rec, err := a.Store.GetRecording(r.Context(), proj.ID, in.RecordingID)
		if err != nil {
			a.fail(w, r, err)
			return
		}
		sh.SessionID, sh.StartMs = rec.ID, max(in.StartMs, 0)
	case store.ShareDashboard:
		if !projectSettings(proj).Analytics.Enabled {
			a.fail(w, r, forbidden("Analytics is off for this project"))
			return
		}
	default:
		a.fail(w, r, invalid("Unknown kind of link", map[string]string{"kind": "Must be recording or dashboard"}))
		return
	}
	token := auth.NewOpaque()
	sh.TokenHash = auth.HashToken(token)
	if err := a.Store.CreateShare(r.Context(), sh); err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, shareView{Share: sh, Link: strings.TrimRight(a.Config.PublicURL, "/") + "/shared/" + token})
}

func (a *API) deleteShare(w http.ResponseWriter, r *http.Request, _ *principal, proj store.Project) {
	if err := a.Store.DeleteShare(r.Context(), proj.ID, r.PathValue("sid")); err != nil {
		a.fail(w, r, err)
		return
	}
	noContent(w)
}

// share resolves a public token to its link and project. A link stops
// working when it expires or is revoked, when its recording or project is
// deleted, and when the project turns public links off.
func (a *API) share(r *http.Request) (store.Share, store.Project, error) {
	sh, err := a.Store.GetShareByHash(r.Context(), auth.HashToken(r.PathValue("token")), time.Now().UnixMilli())
	if err != nil {
		return sh, store.Project{}, err
	}
	proj, err := a.Store.GetProject(r.Context(), sh.OrgID, sh.ProjectID)
	if err != nil {
		return sh, proj, err
	}
	if !projectSettings(proj).Sharing.Enabled {
		return sh, proj, errNotFound
	}
	return sh, proj, nil
}

// sharedRecording is what a public viewer learns about a recording: enough
// to play it, and nothing about who the visitor is.
type sharedRecording struct {
	StartedAt  int64  `json:"startedAt"`
	DurationMs int64  `json:"durationMs"`
	Viewport   string `json:"viewport"`
	Pages      int    `json:"pages"`
	Device     string `json:"device"`
	Browser    string `json:"browser"`
	OS         string `json:"os"`
	Live       bool   `json:"live"`
}

func (a *API) sharedLink(w http.ResponseWriter, r *http.Request) {
	sh, proj, err := a.share(r)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	out := map[string]any{"kind": sh.Kind, "project": proj.Name, "expiresAt": sh.ExpiresAt, "startMs": sh.StartMs}
	if sh.Kind == store.ShareRecording {
		rec, err := a.Store.GetRecording(r.Context(), proj.ID, sh.SessionID)
		if err != nil {
			a.fail(w, r, err)
			return
		}
		v := a.recordingView(rec, time.Now())
		out["recording"] = sharedRecording{StartedAt: v.StartedAt, DurationMs: v.DurationMs, Viewport: v.Viewport, Pages: v.Pages,
			Device: rec.Device, Browser: rec.Browser, OS: rec.OS, Live: v.Live}
	}
	writeJSON(w, http.StatusOK, out)
}

func (a *API) sharedEvents(w http.ResponseWriter, r *http.Request) {
	sh, proj, err := a.share(r)
	if err != nil || sh.Kind != store.ShareRecording {
		a.fail(w, r, errors.Join(err, errNotFound))
		return
	}
	a.streamEvents(w, r, proj.ID, sh.SessionID, replay.PublicEvent)
}

func (a *API) sharedAnalytics(w http.ResponseWriter, r *http.Request) {
	sh, proj, err := a.share(r)
	if err != nil || sh.Kind != store.ShareDashboard || !projectSettings(proj).Analytics.Enabled {
		a.fail(w, r, errors.Join(err, errNotFound))
		return
	}
	out, err := a.trafficView(r, proj)
	answer(a, w, r, publicTraffic(out), err)
}

// sharedTraffic is what a public analytics link returns: counts only. It is
// written out field by field so that nothing added to the signed-in answer
// reaches a public link by accident. No row is about one visitor, and it
// carries no recording, visit, error or feedback.
type sharedTraffic struct {
	Totals      store.TrafficTotals `json:"totals"`
	Previous    store.TrafficTotals `json:"previous"`
	Days        []store.TrafficDay  `json:"days"`
	Sources     []store.Breakdown   `json:"sources"`
	Channels    []store.Breakdown   `json:"channels"`
	Campaigns   []store.Breakdown   `json:"campaigns"`
	Pages       []store.PageMetric  `json:"pages"`
	EntryPages  []store.Breakdown   `json:"entryPages"`
	ExitPages   []store.Breakdown   `json:"exitPages"`
	Countries   []store.Breakdown   `json:"countries"`
	Devices     []store.Breakdown   `json:"devices"`
	Browsers    []store.Breakdown   `json:"browsers"`
	Systems     []store.Breakdown   `json:"systems"`
	Languages   []store.Breakdown   `json:"languages"`
	Goals       []sharedGoal        `json:"goals"`
	GoalSources []store.NameCount   `json:"goalSources"`
}

type sharedGoal struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Kind        string `json:"kind"`
	Value       string `json:"value"`
	Conversions int    `json:"conversions"`
}

func publicTraffic(v trafficView) sharedTraffic {
	t := v.Traffic
	out := sharedTraffic{Totals: t.Totals, Previous: t.Previous, Days: t.Days, Sources: t.Sources, Channels: t.Channels,
		Campaigns: t.Campaigns, Pages: t.Pages, EntryPages: t.EntryPages, ExitPages: t.ExitPages, Countries: t.Countries,
		Devices: t.Devices, Browsers: t.Browsers, Systems: t.Systems, Languages: t.Languages,
		Goals: make([]sharedGoal, 0, len(v.Goals)), GoalSources: v.GoalSources}
	for _, g := range v.Goals {
		out.Goals = append(out.Goals, sharedGoal{g.ID, g.Name, g.Kind, g.Value, g.Conversions})
	}
	return out
}

// Feedback.

func (a *API) listFeedback(w http.ResponseWriter, r *http.Request, _ *principal, proj store.Project) {
	v, err := a.Store.ListFeedback(r.Context(), proj.ID, intParam(r, "page", 0, 0, 1<<20), intParam(r, "limit", 25, 1, 100))
	answer(a, w, r, v, err)
}

func (a *API) patchFeedback(w http.ResponseWriter, r *http.Request, _ *principal, proj store.Project) {
	var in struct {
		Seen *bool `json:"seen"`
	}
	if err := decode(r, &in); err != nil {
		a.fail(w, r, err)
		return
	}
	if in.Seen == nil {
		a.fail(w, r, invalid("Nothing to change", map[string]string{"seen": "Required"}))
		return
	}
	if err := a.Store.SetFeedbackSeen(r.Context(), proj.ID, r.PathValue("fid"), *in.Seen); err != nil {
		a.fail(w, r, err)
		return
	}
	noContent(w)
}

func (a *API) deleteFeedback(w http.ResponseWriter, r *http.Request, _ *principal, proj store.Project) {
	if err := a.Store.DeleteFeedback(r.Context(), proj.ID, r.PathValue("fid")); err != nil {
		a.fail(w, r, err)
		return
	}
	noContent(w)
}

// Alerts.

func notifyProject(proj store.Project) notify.Project {
	return notify.Project{ID: proj.ID, Name: proj.Name, Timezone: proj.Timezone, Alerts: projectSettings(proj).Alerts}
}

// delivered answers a manual delivery: 204, or 400 with what went wrong.
func (a *API) delivered(w http.ResponseWriter, r *http.Request, err error) {
	if err != nil {
		a.fail(w, r, invalid("The webhook did not accept the delivery: "+err.Error(), map[string]string{"alerts.webhookUrl": err.Error()}))
		return
	}
	noContent(w)
}

func (a *API) testWebhook(w http.ResponseWriter, r *http.Request, p *principal, proj store.Project) {
	np := notifyProject(proj)
	a.delivered(w, r, a.Notify.Send(r.Context(), np, notify.Payload{Event: notify.EventTest, Title: "Test from " + proj.Name,
		Text: "kimmi can reach this webhook. " + p.user.Name + " sent this test.",
		URL:  strings.TrimRight(a.Config.PublicURL, "/") + "/projects/" + proj.ID + "/settings/alerts"}))
}

func (a *API) sendDigest(w http.ResponseWriter, r *http.Request, _ *principal, proj store.Project) {
	if !projectSettings(proj).Analytics.Enabled {
		a.fail(w, r, invalid("The digest summarises visits, and analytics is off for this project", nil))
		return
	}
	np := notifyProject(proj)
	payload, err := a.Notify.Digest(r.Context(), np, time.Now())
	if err != nil {
		a.fail(w, r, err)
		return
	}
	a.delivered(w, r, a.Notify.Send(r.Context(), np, payload))
}

// testClock moves the clock alerts go by. It exists only with
// KIMMI_TEST_HOOKS, for kimmi's own tests.
func (a *API) testClock(w http.ResponseWriter, r *http.Request, _ *principal) {
	var in struct {
		OffsetMs int64 `json:"offsetMs"`
	}
	if err := decode(r, &in); err != nil {
		a.fail(w, r, err)
		return
	}
	a.Notify.SetOffset(time.Duration(in.OffsetMs) * time.Millisecond)
	writeJSON(w, http.StatusOK, map[string]any{"now": a.Notify.Now().UnixMilli()})
}

// recordingFilters reads the filters every number of the analytics pages
// links to the recordings list with.
func recordingFilters(r *http.Request, q *store.RecordingQuery) {
	v := r.URL.Query()
	q.Entry, q.Exit, q.Path = v.Get("entry"), v.Get("exit"), v.Get("path")
	q.Referrer, q.Channel, q.UTMSource, q.UTMCampaign = v.Get("referrer"), v.Get("channel"), v.Get("utmSource"), v.Get("utmCampaign")
	q.Country, q.Browser, q.OS, q.Language, q.Release = v.Get("country"), v.Get("browser"), v.Get("os"), v.Get("language"), v.Get("release")
	if v.Get("sort") == "score" {
		q.Sort = "score"
	}
	// event=kind:name, for example error:3f2a..., rage:button.buy or track:signup.
	if kind, name, ok := strings.Cut(v.Get("event"), ":"); ok {
		switch kind {
		case store.KindError, store.KindRage, store.KindDead, store.KindTrack, store.KindRequest:
			q.EventKind, q.EventName, q.EventPath = kind, name, v.Get("eventPath")
		}
	}
}
