package api

import (
	"bufio"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/klauspost/compress/gzip"

	"github.com/dimmihq/kimmi/internal/auth"
	"github.com/dimmihq/kimmi/internal/replay"
	"github.com/dimmihq/kimmi/internal/store"
)

type recordingView struct {
	ID          string        `json:"id"`
	ProjectID   string        `json:"projectId"`
	Visitor     store.Visitor `json:"visitor"`
	StartedAt   int64         `json:"startedAt"`
	LastAt      int64         `json:"lastAt"`
	DurationMs  int64         `json:"durationMs"`
	ActiveMs    int64         `json:"activeMs"`
	Pages       int           `json:"pages"`
	Entry       string        `json:"entry"`
	Exit        string        `json:"exit"`
	CurrentPath string        `json:"currentPath"`
	Clicks      int           `json:"clicks"`
	Keypresses  int           `json:"keypresses"`
	RageClicks  int           `json:"rageClicks"`
	DeadClicks  int           `json:"deadClicks"`
	Errors      int           `json:"errors"`
	Viewport    string        `json:"viewport"`
	SizeBytes   int64         `json:"sizeBytes"`
	Seen        bool          `json:"seen"`
	Live        bool          `json:"live"`
	Starred     bool          `json:"starred"`
	Release     *string       `json:"release"`
	Referrer    *string       `json:"referrer"`
}

func optional(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func (a *API) isLive(r store.Recording, now time.Time) bool {
	return !r.Sealed && r.LastAt >= now.Add(-a.Config.LiveWindow).UnixMilli()
}

func (a *API) recordingView(r store.Recording, now time.Time) recordingView {
	return recordingView{
		ID: r.ID, ProjectID: r.ProjectID, Visitor: r.Visitor, StartedAt: r.StartedAt, LastAt: r.LastAt,
		DurationMs: r.DurationMs, ActiveMs: r.ActiveMs, Pages: r.Pages, Entry: r.EntryPath, Exit: r.ExitPath,
		CurrentPath: r.ExitPath, Clicks: r.Clicks, Keypresses: r.Keypresses, RageClicks: r.RageClicks,
		DeadClicks: r.DeadClicks, Errors: r.Errors, Viewport: fmt.Sprintf("%d × %d", r.ViewportW, r.ViewportH),
		SizeBytes: r.SizeBytes, Seen: r.Seen, Live: a.isLive(r, now), Starred: r.Starred,
		Release: optional(r.Release), Referrer: optional(r.Referrer),
	}
}

func (a *API) recordingViews(list []store.Recording) []recordingView {
	now := time.Now()
	out := make([]recordingView, len(list))
	for i, r := range list {
		out[i] = a.recordingView(r, now)
	}
	return out
}

func intParam(r *http.Request, key string, fallback, lo, hi int) int {
	n, err := strconv.Atoi(r.URL.Query().Get(key))
	if err != nil {
		return fallback
	}
	return min(max(n, lo), hi)
}

// today returns the start of the project's current day and its UTC offset.
func today(tz string, now time.Time) (start, offset int64) {
	offset = dayOffset(tz)
	ms := now.UnixMilli()
	return (ms+offset)/store.DayMs*store.DayMs - offset, offset
}

func (a *API) overview(w http.ResponseWriter, r *http.Request, _ *principal, proj store.Project) {
	days := 7
	switch r.URL.Query().Get("days") {
	case "14":
		days = 14
	case "30":
		days = 30
	}
	now := time.Now()
	start, off := today(proj.Timezone, now)
	from := start - int64(days-1)*store.DayMs
	o, err := a.Store.Overview(r.Context(), store.OverviewQuery{ProjectID: proj.ID, From: from, To: now.UnixMilli() + 1,
		PrevFrom: from - int64(days)*store.DayMs, TodayFrom: start, DayOffsetMs: off})
	if err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, o)
}

func (a *API) listRecordings(w http.ResponseWriter, r *http.Request, _ *principal, proj store.Project) {
	q := r.URL.Query()
	query := store.RecordingQuery{
		ProjectID: proj.ID, View: q.Get("view"), Q: strings.TrimSpace(q.Get("q")), Duration: q.Get("duration"),
		Device: q.Get("device"), Rage: q.Get("rage") == "1", Errors: q.Get("errors") == "1", VisitorID: q.Get("visitor"),
		Page: intParam(r, "page", 0, 0, 1<<20), Limit: intParam(r, "limit", 25, 1, 100),
	}
	recordingFilters(r, &query)
	page, err := a.Store.ListRecordings(r.Context(), query)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": a.recordingViews(page.Items), "total": page.Total, "counts": page.Counts})
}

type recordingDetail struct {
	recordingView
	NewerID *string `json:"newerId"`
	OlderID *string `json:"olderId"`
}

func (a *API) getRecording(w http.ResponseWriter, r *http.Request, _ *principal, proj store.Project) {
	rec, err := a.Store.GetRecording(r.Context(), proj.ID, r.PathValue("rid"))
	if err != nil {
		a.fail(w, r, err)
		return
	}
	newer, older, err := a.Store.RecordingNeighbors(r.Context(), proj.ID, rec)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, recordingDetail{a.recordingView(rec, time.Now()), optional(newer), optional(older)})
}

// recordingEvents streams {events, lastSeq, complete}. The events array is
// written chunk by chunk, so memory stays flat however long the recording is.
func (a *API) recordingEvents(w http.ResponseWriter, r *http.Request, _ *principal, proj store.Project) {
	a.streamEvents(w, r, proj.ID, r.PathValue("rid"))
}

func (a *API) streamEvents(w http.ResponseWriter, r *http.Request, projectID, recordingID string) {
	after := int64(-1)
	if s := r.URL.Query().Get("after"); s != "" {
		n, err := strconv.ParseInt(s, 10, 64)
		if err != nil || n < -1 {
			a.fail(w, r, invalid("after must be a block seq, or -1 for everything", nil))
			return
		}
		after = n
	}
	rec, err := a.Store.GetRecording(r.Context(), projectID, recordingID)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	blocks, err := a.Store.ListBlocks(r.Context(), rec.ID, after)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	lastSeq := max(rec.LastSeq, after)
	if len(blocks) > 0 {
		lastSeq = max(lastSeq, blocks[len(blocks)-1].Seq)
	}
	complete := !a.isLive(rec, time.Now())

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Vary", "Accept-Encoding")
	out := bufio.NewWriterSize(w, 64<<10)
	var zw *gzip.Writer
	if strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
		w.Header().Set("Content-Encoding", "gzip")
		zw = gzipWriters.Get().(*gzip.Writer)
		zw.Reset(w)
		defer gzipWriters.Put(zw)
		out = bufio.NewWriterSize(zw, 64<<10)
	}
	out.WriteString(`{"events":[`)
	if err := a.Source.WriteEvents(r.Context(), &replay.ArrayWriter{W: out}, rec, blocks, after); err != nil {
		// Headers are gone; cutting the connection is the only honest signal.
		a.Log.Error("stream recording events", "recording", rec.ID, "err", err)
		panic(http.ErrAbortHandler)
	}
	fmt.Fprintf(out, `],"lastSeq":%d,"complete":%t}`, lastSeq, complete)
	if err := out.Flush(); err != nil {
		return
	}
	if zw != nil {
		zw.Close()
	}
}

// gzipWriters reuses compressors: each holds about a megabyte of state.
var gzipWriters = sync.Pool{New: func() any {
	zw, _ := gzip.NewWriterLevel(nil, gzip.BestSpeed)
	return zw
}}

func (a *API) patchRecording(w http.ResponseWriter, r *http.Request, p *principal, proj store.Project) {
	var in struct{ Starred, Seen *bool }
	if err := decode(r, &in); err != nil {
		a.fail(w, r, err)
		return
	}
	if in.Starred != nil {
		role, err := a.projectRole(r, p, proj.ID)
		if err != nil {
			a.fail(w, r, err)
			return
		}
		if !auth.AtLeast(role, store.RoleMember) {
			a.fail(w, r, forbidden("Viewers cannot star recordings"))
			return
		}
	}
	id := r.PathValue("rid")
	if err := a.Store.SetRecordingFlags(r.Context(), proj.ID, id, in.Starred, in.Seen); err != nil {
		a.fail(w, r, err)
		return
	}
	rec, err := a.Store.GetRecording(r.Context(), proj.ID, id)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, a.recordingView(rec, time.Now()))
}

func (a *API) deleteRecording(w http.ResponseWriter, r *http.Request, _ *principal, proj store.Project) {
	if err := a.Store.DeleteRecording(r.Context(), proj.ID, r.PathValue("rid"), time.Now().UnixMilli()); err != nil {
		a.fail(w, r, err)
		return
	}
	noContent(w)
}

func (a *API) live(w http.ResponseWriter, r *http.Request, _ *principal, proj store.Project) {
	now := time.Now()
	l, err := a.Store.Live(r.Context(), proj.ID, now.Add(-a.Config.LiveWindow).UnixMilli(), now.Add(-5*time.Minute).UnixMilli())
	if err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"visitors": l.Visitors, "activeLast5m": l.ActiveLast5m,
		"pages": l.Pages, "countries": l.Countries, "sessions": a.recordingViews(l.Sessions)})
}
