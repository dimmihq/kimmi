// Package notify sends a project's alerts and its weekly digest to the one
// webhook the project names. Nothing is sent for a project without a URL.
package notify

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/dimmihq/kimmi/internal/settings"
	"github.com/dimmihq/kimmi/internal/store"
)

// Event names of a delivery.
const (
	EventTest       = "test"
	EventNewError   = "error.new"
	EventErrorSpike = "error.spike"
	EventRageSpike  = "rage.spike"
	EventNoTraffic  = "traffic.none"
	EventFeedback   = "feedback.new"
	EventDigest     = "digest.weekly"
)

// Payload is the JSON body of every delivery.
type Payload struct {
	Event   string         `json:"event"`
	Project ProjectRef     `json:"project"`
	At      int64          `json:"at"`
	Title   string         `json:"title"`
	Text    string         `json:"text"`
	URL     string         `json:"url"`
	Data    map[string]any `json:"data,omitempty"`
}

// ProjectRef names the project a delivery is about.
type ProjectRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Project is what the notifier needs to know about a project.
type Project struct {
	ID, Name, Timezone string
	Alerts             settings.Alerts
}

// spikeWindow is the hour a spike is counted over, and how long a spike or
// a silence alert stays quiet after firing.
const spikeWindow = time.Hour

// Notifier evaluates alerts and delivers them.
type Notifier struct {
	Store     store.Store
	Log       *slog.Logger
	PublicURL string
	Version   string
	// Lookup finds a live project; used for alerts raised by incoming data.
	Lookup func(id string) (Project, bool)
	Client *http.Client

	queue chan func(ctx context.Context)
	// offset moves the clock alerts go by; only tests set it.
	offset atomic.Int64

	mu        sync.Mutex
	announced map[string]bool      // project + fingerprint already alerted on by this process
	checked   map[string]time.Time // project + rule: when its spike was last counted
}

// New returns a notifier; call Run to deliver what Hits and Feedback queue.
func New(s store.Store, log *slog.Logger, publicURL, version string, lookup func(id string) (Project, bool)) *Notifier {
	return &Notifier{Store: s, Log: log, PublicURL: strings.TrimRight(publicURL, "/"), Version: version, Lookup: lookup,
		Client: &http.Client{Timeout: 5 * time.Second,
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
		queue: make(chan func(ctx context.Context), 64), announced: map[string]bool{}, checked: map[string]time.Time{}}
}

// Now is the time alerts go by: the real time, unless a test moved it.
func (n *Notifier) Now() time.Time { return time.Now().Add(time.Duration(n.offset.Load())) }

// SetOffset moves the clock alerts go by. For tests only.
func (n *Notifier) SetOffset(d time.Duration) { n.offset.Store(int64(d)) }

// Run delivers queued work until ctx ends.
func (n *Notifier) Run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case job := <-n.queue:
			job(ctx)
		}
	}
}

// enqueue never blocks the caller: when deliveries are behind, work is dropped.
func (n *Notifier) enqueue(job func(ctx context.Context)) {
	select {
	case n.queue <- job:
	default:
		n.Log.Warn("alert queue is full; dropping one check")
	}
}

func (n *Notifier) link(projectID, path string) string {
	return n.PublicURL + "/projects/" + projectID + path
}

// seen is one error of a flush.
type seen struct {
	fingerprint, message, path, visit string
	ts                                int64
}

// Hits looks at one stored flush of analytics hits for things to alert on.
// It only collects; the store is asked from Run.
func (n *Notifier) Hits(hits []store.Hit) {
	type found struct {
		errors []seen
		rage   bool
	}
	byProject := map[string]*found{}
	for _, h := range hits {
		for _, e := range h.Events {
			if e.Kind != store.KindError && e.Kind != store.KindRage {
				continue
			}
			f := byProject[h.ProjectID]
			if f == nil {
				f = &found{}
				byProject[h.ProjectID] = f
			}
			if e.Kind == store.KindRage {
				f.rage = true
			} else if len(f.errors) < 20 {
				f.errors = append(f.errors, seen{e.Name, e.Label, e.Path, h.VisitID, e.Ts})
			}
		}
	}
	for id, f := range byProject {
		p, ok := n.Lookup(id)
		if !ok || p.Alerts.WebhookURL == "" {
			continue
		}
		n.enqueue(func(ctx context.Context) {
			if p.Alerts.NewErrors {
				n.newErrors(ctx, p, f.errors)
			}
			if len(f.errors) > 0 && p.Alerts.ErrorSpike > 0 {
				n.spike(ctx, p, store.KindError, EventErrorSpike, p.Alerts.ErrorSpike, "errors", "/errors")
			}
			if f.rage && p.Alerts.RageSpike > 0 {
				n.spike(ctx, p, store.KindRage, EventRageSpike, p.Alerts.RageSpike, "rage clicks", "/friction")
			}
		})
	}
}

func (n *Notifier) newErrors(ctx context.Context, p Project, errs []seen) {
	first := map[string]seen{}
	for _, e := range errs {
		if cur, ok := first[e.fingerprint]; !ok || e.ts < cur.ts {
			first[e.fingerprint] = e
		}
	}
	for fp, e := range first {
		key := p.ID + " " + fp
		n.mu.Lock()
		done := n.announced[key]
		if len(n.announced) > 10_000 {
			clear(n.announced)
		}
		n.announced[key] = true
		n.mu.Unlock()
		if done {
			continue
		}
		before, err := n.Store.EventSeenBefore(ctx, p.ID, store.KindError, fp, e.ts)
		if err != nil {
			n.Log.Warn("alert: look up error", "err", err)
			continue
		}
		if before {
			continue
		}
		n.deliver(ctx, p, Payload{Event: EventNewError, Title: "New error in " + p.Name,
			Text: e.message + " on " + e.path, URL: n.link(p.ID, "/errors/"+fp),
			Data: map[string]any{"fingerprint": fp, "message": e.message, "path": e.path, "visitId": e.visit}})
	}
}

// spike fires when the last hour holds at least threshold events of kind,
// at most once an hour, counting at most once a minute.
func (n *Notifier) spike(ctx context.Context, p Project, kind, event string, threshold int, noun, page string) {
	now := n.Now()
	key := p.ID + " " + event
	n.mu.Lock()
	recent := now.Sub(n.checked[key]) < time.Minute
	if !recent {
		n.checked[key] = now
	}
	n.mu.Unlock()
	if recent {
		return
	}
	count, err := n.Store.CountEvents(ctx, p.ID, kind, now.Add(-spikeWindow).UnixMilli())
	if err != nil {
		n.Log.Warn("alert: count events", "err", err)
		return
	}
	if count < threshold || !n.due(ctx, p.ID, "alert."+event, now, spikeWindow) {
		return
	}
	n.deliver(ctx, p, Payload{Event: event, Title: fmt.Sprintf("%d %s in the last hour in %s", count, noun, p.Name),
		Text: fmt.Sprintf("%s has seen %d %s in the last hour; the alert is set at %d.", p.Name, count, noun, threshold),
		URL:  n.link(p.ID, page), Data: map[string]any{"count": count, "threshold": threshold}})
}

// due reports whether the named alert last fired longer than every ago,
// and if so records that it fires now.
func (n *Notifier) due(ctx context.Context, projectID, name string, now time.Time, every time.Duration) bool {
	last, err := n.Store.GetState(ctx, projectID, name)
	if err != nil {
		n.Log.Warn("alert: read state", "err", err)
		return false
	}
	if ms, _ := strconv.ParseInt(last, 10, 64); ms > 0 && now.Sub(time.UnixMilli(ms)) < every {
		return false
	}
	if err := n.Store.SetState(ctx, projectID, name, strconv.FormatInt(now.UnixMilli(), 10), now.UnixMilli()); err != nil {
		n.Log.Warn("alert: write state", "err", err)
		return false
	}
	return true
}

// Feedback announces a visitor's message.
func (n *Notifier) Feedback(f store.Feedback) {
	p, ok := n.Lookup(f.ProjectID)
	if !ok || p.Alerts.WebhookURL == "" || !p.Alerts.Feedback {
		return
	}
	n.enqueue(func(ctx context.Context) {
		n.deliver(ctx, p, Payload{Event: EventFeedback, Title: "Feedback on " + f.Path + " in " + p.Name, Text: f.Body,
			URL: n.link(p.ID, "/feedback"), Data: map[string]any{"id": f.ID, "path": f.Path, "email": f.Email, "visitId": f.VisitID}})
	})
}

// Periodic runs the checks that follow the clock: a day without visits and
// the Monday digest. The worker calls it every few minutes.
func (n *Notifier) Periodic(ctx context.Context, projects []Project, now time.Time) {
	for _, p := range projects {
		if p.Alerts.WebhookURL == "" {
			continue
		}
		if p.Alerts.NoTraffic {
			last, err := n.Store.LastVisitAt(ctx, p.ID)
			if err == nil && last > 0 && now.Sub(time.UnixMilli(last)) > 24*time.Hour && n.due(ctx, p.ID, "alert."+EventNoTraffic, now, 24*time.Hour) {
				n.deliver(ctx, p, Payload{Event: EventNoTraffic, Title: "No visits to " + p.Name + " for a day",
					Text: "The last visit was " + time.UnixMilli(last).UTC().Format("2 Jan 15:04") + " UTC. Check that the site is up and the snippet is still on it.",
					URL:  n.link(p.ID, "/analytics"), Data: map[string]any{"lastVisitAt": last}})
			}
		}
		if p.Alerts.WeeklyDigest {
			n.weekly(ctx, p, now)
		}
	}
}

// weekly sends the digest once per week, on Monday from 8 in the morning
// of the project's time zone.
func (n *Notifier) weekly(ctx context.Context, p Project, now time.Time) {
	loc, err := time.LoadLocation(p.Timezone)
	if err != nil {
		loc = time.UTC
	}
	local := now.In(loc)
	if local.Weekday() != time.Monday || local.Hour() < 8 {
		return
	}
	week := local.Format(time.DateOnly)
	if last, err := n.Store.GetState(ctx, p.ID, "digest.week"); err != nil || last == week {
		return
	}
	if err := n.Store.SetState(ctx, p.ID, "digest.week", week, now.UnixMilli()); err != nil {
		return
	}
	payload, err := n.Digest(ctx, p, now)
	if err != nil {
		n.Log.Warn("weekly digest", "project", p.ID, "err", err)
		return
	}
	n.deliver(ctx, p, payload)
}

func percent(part, whole int) string {
	if whole == 0 {
		return "0%"
	}
	return strconv.Itoa((part*100+whole/2)/whole) + "%"
}

func change(now, before int) string {
	switch {
	case before == 0 && now == 0:
		return "no change"
	case before == 0:
		return "new"
	}
	d := (now - before) * 100 / before
	if d >= 0 {
		return "+" + strconv.Itoa(d) + "%"
	}
	return strconv.Itoa(d) + "%"
}

// Digest builds the last seven days' summary of a project.
func (n *Notifier) Digest(ctx context.Context, p Project, now time.Time) (Payload, error) {
	to := now.UnixMilli()
	from := to - 7*store.DayMs
	q := store.AnalyticsQuery{ProjectID: p.ID, From: from, To: to, PrevFrom: from - 7*store.DayMs}
	traffic, err := n.Store.Traffic(ctx, q)
	if err != nil {
		return Payload{}, err
	}
	errs, err := n.Store.ErrorGroups(ctx, q)
	if err != nil {
		return Payload{}, err
	}
	friction, err := n.Store.Friction(ctx, q)
	if err != nil {
		return Payload{}, err
	}
	watch, err := n.Store.ListRecordings(ctx, store.RecordingQuery{ProjectID: p.ID, View: "unwatched", Sort: "score", Limit: 3})
	if err != nil {
		return Payload{}, err
	}
	t, prev := traffic.Totals, traffic.Previous
	var b strings.Builder
	fmt.Fprintf(&b, "%d visitors (%s), %d visits, %d page views, %s bounced.", t.Visitors, change(t.Visitors, prev.Visitors),
		t.Visits, t.Pageviews, percent(t.Bounces, t.Visits))
	list := func(title string, rows []string) {
		if len(rows) > 0 {
			b.WriteString("\n" + title + ": " + strings.Join(rows, ", ") + ".")
		}
	}
	var pages, sources, errors, elements []string
	for _, pg := range traffic.Pages[:min(len(traffic.Pages), 5)] {
		pages = append(pages, fmt.Sprintf("%s (%d)", pg.Path, pg.Views))
	}
	for _, s := range traffic.Sources[:min(len(traffic.Sources), 5)] {
		sources = append(sources, fmt.Sprintf("%s (%d)", s.Name, s.Visitors))
	}
	for _, e := range errs[:min(len(errs), 3)] {
		errors = append(errors, fmt.Sprintf("%s (%d visits)", e.Message, e.Visits))
	}
	for _, e := range friction.Elements[:min(len(friction.Elements), 3)] {
		name := e.Label
		if name == "" {
			name = e.Selector
		}
		elements = append(elements, fmt.Sprintf("%s on %s (%d visits)", name, e.Path, e.Visits))
	}
	list("Top pages", pages)
	list("Top sources", sources)
	list("Errors", errors)
	list("Rage and dead clicks", elements)
	recordings := make([]map[string]any, 0, len(watch.Items))
	for _, r := range watch.Items {
		recordings = append(recordings, map[string]any{"id": r.ID, "url": n.link(p.ID, "/recordings/"+r.ID), "entry": r.EntryPath,
			"errors": r.Errors, "rageClicks": r.RageClicks, "durationMs": r.DurationMs})
	}
	if len(recordings) > 0 {
		fmt.Fprintf(&b, "\n%d recordings worth watching.", len(recordings))
	}
	return Payload{Event: EventDigest, Title: "Your week on " + p.Name, Text: b.String(), URL: n.link(p.ID, "/analytics"),
		Data: map[string]any{"from": from, "to": to, "totals": t, "previous": prev, "pages": traffic.Pages[:min(len(traffic.Pages), 5)],
			"sources": traffic.Sources[:min(len(traffic.Sources), 5)], "errors": errs[:min(len(errs), 3)],
			"elements": friction.Elements[:min(len(friction.Elements), 3)], "recordings": recordings}}, nil
}

func (n *Notifier) deliver(ctx context.Context, p Project, payload Payload) {
	if err := n.Send(ctx, p, payload); err != nil {
		n.Log.Warn("webhook delivery failed", "project", p.ID, "event", payload.Event, "err", err)
	}
}

// Send posts one payload to the project's webhook and reports how it went.
func (n *Notifier) Send(ctx context.Context, p Project, payload Payload) error {
	if p.Alerts.WebhookURL == "" {
		return fmt.Errorf("no webhook URL is set")
	}
	payload.Project = ProjectRef{ID: p.ID, Name: p.Name}
	if payload.At == 0 {
		payload.At = n.Now().UnixMilli()
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.Alerts.WebhookURL, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "kimmi/"+n.Version)
	req.Header.Set("X-Kimmi-Event", payload.Event)
	if p.Alerts.Secret != "" {
		mac := hmac.New(sha256.New, []byte(p.Alerts.Secret))
		mac.Write(body)
		req.Header.Set("X-Kimmi-Signature", "sha256="+hex.EncodeToString(mac.Sum(nil)))
	}
	res, err := n.Client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 64<<10))
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return fmt.Errorf("the webhook answered %d", res.StatusCode)
	}
	return nil
}
