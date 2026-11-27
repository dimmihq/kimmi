package ingest

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/dimmihq/kimmi/internal/geo"
	"github.com/dimmihq/kimmi/internal/guard"
	"github.com/dimmihq/kimmi/internal/store"
	"github.com/dimmihq/kimmi/internal/useragent"
)

// MaxHitBytes is the largest analytics hit accepted; maxHitEvents the most
// events one hit may carry.
const (
	MaxHitBytes      = 64 << 10
	maxHitEvents     = 200
	maxFeedbackBytes = 8 << 10
)

// SaltStore keeps the daily secret of cookieless visitor hashes.
type SaltStore interface {
	DaySalt(ctx context.Context, day string) (string, error)
}

// FeedbackStore stores a visitor's feedback.
type FeedbackStore interface {
	CreateFeedback(ctx context.Context, f store.Feedback) error
}

// Salts hands out the day's salt, asking the store once a day.
type Salts struct {
	Store SaltStore

	mu   sync.Mutex
	day  string
	salt string
}

// For returns the salt of the UTC day of now.
func (s *Salts) For(ctx context.Context, now time.Time) (string, error) {
	day := now.UTC().Format(time.DateOnly)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.day == day {
		return s.salt, nil
	}
	salt, err := s.Store.DaySalt(ctx, day)
	if err != nil {
		return "", err
	}
	s.day, s.salt = day, salt
	return salt, nil
}

// hitBody is what the SDK posts to /i/v1/hit.
type hitBody struct {
	V           int    `json:"v"`
	VisitID     string `json:"visitId"`
	AnonymousID string `json:"anonymousId"`
	StartedAt   int64  `json:"startedAt"`
	URL         string `json:"url"`
	Landing     string `json:"landing"`
	Referrer    string `json:"referrer"`
	Viewport    struct {
		W int `json:"w"`
		H int `json:"h"`
	} `json:"viewport"`
	Language string     `json:"language"`
	Timezone string     `json:"timezone"`
	Release  string     `json:"release"`
	Events   []hitEvent `json:"events"`
}

type hitEvent struct {
	T   int64           `json:"t"`
	K   string          `json:"k"`
	P   string          `json:"p"`
	N   string          `json:"n"`
	L   string          `json:"l"`
	V   float64         `json:"v"`
	X   int             `json:"x"`
	Y   int             `json:"y"`
	W   int             `json:"w"`
	Num int             `json:"num"`
	D   json.RawMessage `json:"d"`
}

// cut shortens s to at most n bytes without splitting a character.
func cut(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}

var kinds = map[string]bool{store.KindPage: true, store.KindLeave: true, store.KindTrack: true, store.KindError: true,
	store.KindRage: true, store.KindDead: true, store.KindClick: true, store.KindRequest: true, store.KindVital: true}

// readSmall reads a body of at most limit bytes.
func readSmall(w http.ResponseWriter, r *http.Request, limit int64) ([]byte, int) {
	if r.ContentLength > limit {
		return nil, http.StatusRequestEntityTooLarge
	}
	_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(bodyTimeout))
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, limit))
	var tooBig *http.MaxBytesError
	if errors.As(err, &tooBig) {
		return nil, http.StatusRequestEntityTooLarge
	}
	if err != nil {
		return nil, http.StatusBadRequest
	}
	return body, 0
}

// admit runs the checks every analytics post shares and returns the project.
func (h *Handler) admit(w http.ResponseWriter, r *http.Request) (*Project, bool) {
	h.Stats.request(time.Now())
	cors(w)
	p, ok := h.Cache.Lookup(r.URL.Query().Get("key"))
	if !ok || !p.Allows(r.Header.Get("Origin")) || !p.Settings.Analytics.Enabled {
		h.reject(w, http.StatusForbidden)
		return nil, false
	}
	if ok, wait := h.Limit.Allow(p.ID + " " + h.Proxies.LimitKey(r)); !ok {
		w.Header().Set("Retry-After", guard.RetryAfter(wait))
		h.reject(w, http.StatusTooManyRequests)
		return nil, false
	}
	return p, true
}

// visitorKey names the visitor behind a post: the anonymous id the browser
// keeps, or, when it keeps none, a hash that changes every day.
func (h *Handler) visitorKey(r *http.Request, p *Project, anonymousID string, now time.Time) (key string, cookieless bool, err error) {
	if anonymousID != "" {
		return "a:" + cut(anonymousID, 128), false, nil
	}
	salt, err := h.Salts.For(r.Context(), now)
	if err != nil {
		return "", true, err
	}
	sum := sha256.Sum256([]byte(salt + "|" + p.ID + "|" + h.Proxies.String(r) + "|" + r.UserAgent()))
	return "h:" + hex.EncodeToString(sum[:16]), true, nil
}

func (h *Handler) hit(w http.ResponseWriter, r *http.Request) {
	p, ok := h.admit(w, r)
	if !ok {
		return
	}
	body, status := readSmall(w, r, MaxHitBytes)
	if status != 0 {
		h.reject(w, status)
		return
	}
	var in hitBody
	if err := json.Unmarshal(body, &in); err != nil || in.V != 1 || in.VisitID == "" || len(in.VisitID) > 64 || len(in.Events) > maxHitEvents {
		h.reject(w, http.StatusBadRequest)
		return
	}
	now := time.Now()
	key, cookieless, err := h.visitorKey(r, p, in.AnonymousID, now)
	if err != nil {
		w.Header().Set("Retry-After", "2")
		h.reject(w, http.StatusServiceUnavailable)
		return
	}
	agent := useragent.Parse(r.UserAgent())
	src := classify(in.URL, in.Landing, in.Referrer)
	out := store.Hit{OrgID: p.OrgID, ProjectID: p.ID, VisitID: in.VisitID, VisitorKey: key, Cookieless: cookieless,
		StartedAt: in.StartedAt, At: now.UnixMilli(),
		Referrer: src.referrer, Channel: src.channel, UTMSource: src.utmSource, UTMMedium: src.utmMedium, UTMCampaign: src.utmCampaign,
		CountryCode: geo.FromTimezone(in.Timezone).CountryCode, Device: agent.Device, Browser: agent.Browser, OS: agent.OS,
		Language: cut(in.Language, 20), ViewportW: in.Viewport.W, Release: cut(in.Release, 100),
		Events: make([]store.Event, 0, len(in.Events))}
	for _, e := range in.Events {
		if ev, ok := event(e, out.At); ok {
			out.Events = append(out.Events, ev)
		}
	}
	if err := h.Flusher.AddHit(out, hitCost(len(body), len(out.Events))); err != nil {
		w.Header().Set("Retry-After", "2")
		h.reject(w, http.StatusServiceUnavailable)
		return
	}
	h.Stats.Accepted.Add(1)
	h.Stats.Bytes.Add(int64(len(body)))
	w.WriteHeader(http.StatusNoContent)
}

// hitCost is what a parsed hit holds in memory until it is written: its
// strings (about the body again) and a fixed part per hit and per event.
func hitCost(body, events int) int64 {
	return int64(body) + 512 + int64(events)*192
}

// event checks one posted event and turns it into an index row.
func event(e hitEvent, now int64) (store.Event, bool) {
	if !kinds[e.K] {
		return store.Event{}, false
	}
	ts := e.T
	if ts < now-store.DayMs || ts > now+60_000 {
		ts = now
	}
	path := cut(e.P, 300)
	if path == "" {
		path = "/"
	}
	out := store.Event{Ts: ts, Kind: e.K, Path: path, Name: cut(e.N, 200), Label: cut(e.L, 300), Value: e.V,
		X: e.X, Y: e.Y, W: e.W, Num: e.Num}
	if len(e.D) > 2 && len(e.D) <= 4096 && e.D[0] == '{' && json.Valid(e.D) {
		out.Props = string(e.D)
	}
	switch e.K {
	case store.KindTrack, store.KindRage, store.KindDead, store.KindRequest, store.KindVital:
		if out.Name == "" {
			return out, false
		}
	case store.KindError:
		if out.Label == "" {
			return out, false
		}
		out.Name = fingerprint(out.Label, out.Props)
	case store.KindClick:
		out.X = min(max(out.X, 0), 10000)
		out.Y = max(out.Y, 0)
	case store.KindLeave:
		out.Num = min(max(out.Num, 0), 100)
		out.Value = min(max(out.Value, 0), 6*3600_000)
	}
	return out, true
}

var (
	numbers   = regexp.MustCompile(`[0-9]+`)
	frameSpot = regexp.MustCompile(`:[0-9]+(:[0-9]+)?\)?$`)
)

// fingerprint groups errors: the message with its numbers flattened, plus
// the first stack frame without its line and column, so one bug keeps one
// group across page loads.
func fingerprint(message, props string) string {
	var p struct {
		Stack string `json:"stack"`
	}
	_ = json.Unmarshal([]byte(props), &p)
	frame := ""
	for _, line := range strings.Split(p.Stack, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "at ") || strings.Contains(line, "@") {
			frame = frameSpot.ReplaceAllString(line, "")
			if i := strings.IndexAny(frame, "?#"); i >= 0 {
				frame = frame[:i]
			}
			break
		}
	}
	sum := sha256.Sum256([]byte(numbers.ReplaceAllString(cut(message, 300), "0") + "\n" + frame))
	return hex.EncodeToString(sum[:8])
}

// feedbackBody is what kimmi.feedback() posts to /i/v1/feedback.
type feedbackBody struct {
	V           int    `json:"v"`
	VisitID     string `json:"visitId"`
	AnonymousID string `json:"anonymousId"`
	Path        string `json:"path"`
	Text        string `json:"text"`
	Email       string `json:"email"`
}

func (h *Handler) feedback(w http.ResponseWriter, r *http.Request) {
	p, ok := h.admit(w, r)
	if !ok {
		return
	}
	body, status := readSmall(w, r, maxFeedbackBytes)
	if status != 0 {
		h.reject(w, status)
		return
	}
	var in feedbackBody
	if err := json.Unmarshal(body, &in); err != nil || in.V != 1 || in.VisitID == "" || len(in.VisitID) > 64 || strings.TrimSpace(in.Text) == "" {
		h.reject(w, http.StatusBadRequest)
		return
	}
	now := time.Now()
	key, _, err := h.visitorKey(r, p, in.AnonymousID, now)
	if err != nil {
		w.Header().Set("Retry-After", "2")
		h.reject(w, http.StatusServiceUnavailable)
		return
	}
	path := cut(in.Path, 300)
	if path == "" {
		path = "/"
	}
	f := store.Feedback{ID: store.NewID(), OrgID: p.OrgID, ProjectID: p.ID, VisitID: in.VisitID, VisitorKey: key, Path: path,
		Body: cut(strings.TrimSpace(in.Text), 2000), Email: cut(strings.TrimSpace(in.Email), 200), CreatedAt: now.UnixMilli()}
	if err := h.Feedback.CreateFeedback(r.Context(), f); err != nil {
		w.Header().Set("Retry-After", "2")
		h.reject(w, http.StatusServiceUnavailable)
		return
	}
	if h.OnFeedback != nil {
		h.OnFeedback(f)
	}
	h.Stats.Accepted.Add(1)
	w.WriteHeader(http.StatusNoContent)
}

// source is where a visit came from.
type source struct {
	referrer, channel                 string
	utmSource, utmMedium, utmCampaign string
}

var (
	searchHosts = []string{"google.", "bing.com", "duckduckgo.com", "yahoo.", "yandex.", "baidu.com", "ecosia.org", "brave.com", "startpage.com", "kagi.com", "qwant.com"}
	socialHosts = []string{"facebook.com", "instagram.com", "twitter.com", "x.com", "t.co", "linkedin.com", "lnkd.in", "reddit.com", "youtube.com", "youtu.be",
		"tiktok.com", "pinterest.", "threads.net", "threads.com", "bsky.app", "mastodon.", "news.ycombinator.com", "producthunt.com", "whatsapp.com", "telegram.org", "t.me"}
	aiHosts     = []string{"chatgpt.com", "chat.openai.com", "openai.com", "perplexity.ai", "claude.ai", "gemini.google.com", "copilot.microsoft.com", "you.com", "phind.com", "poe.com", "deepseek.com", "grok.com"}
	paidMediums = []string{"cpc", "ppc", "paid", "paidsearch", "paid-search", "paid_search", "paidsocial", "paid-social", "paid_social", "display", "banner", "cpm", "ads", "ad"}
	clickIDs    = []string{"gclid", "gbraid", "wbraid", "msclkid", "ttclid", "twclid", "li_fat_id"}
)

func hostIn(host string, list []string) bool {
	for _, h := range list {
		if strings.HasSuffix(h, ".") {
			// "google." matches google.com and www.google.co.uk
			if strings.HasPrefix(host, h) || strings.Contains(host, "."+h) {
				return true
			}
			continue
		}
		if host == h || strings.HasSuffix(host, "."+h) {
			return true
		}
	}
	return false
}

func hostOf(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	return strings.TrimPrefix(strings.ToLower(u.Hostname()), "www.")
}

// classify reads a visit's source from its landing URL and referrer. A
// referrer on the site's own host is not a source.
func classify(page, landing, referrer string) source {
	var s source
	if landing == "" {
		landing = page
	}
	paid := false
	if u, err := url.Parse(landing); err == nil {
		q := u.Query()
		s.utmSource = cut(strings.ToLower(strings.TrimSpace(q.Get("utm_source"))), 100)
		s.utmMedium = cut(strings.ToLower(strings.TrimSpace(q.Get("utm_medium"))), 100)
		s.utmCampaign = cut(strings.TrimSpace(q.Get("utm_campaign")), 100)
		for _, id := range clickIDs {
			if q.Has(id) {
				paid = true
			}
		}
	}
	host := hostOf(referrer)
	if own := hostOf(page); host == own || host == hostOf(landing) {
		host = ""
	}
	s.referrer = cut(host, 200)
	medium := s.utmMedium
	for _, m := range paidMediums {
		if medium == m {
			paid = true
		}
	}
	switch {
	case paid:
		s.channel = "Paid"
	case medium == "email" || medium == "newsletter" || s.utmSource == "newsletter":
		s.channel = "Email"
	case hostIn(host, aiHosts) || hostIn(s.utmSource, aiHosts):
		s.channel = "AI"
	case hostIn(host, searchHosts):
		s.channel = "Search"
	case hostIn(host, socialHosts) || medium == "social":
		s.channel = "Social"
	case host != "":
		s.channel = "Referral"
	case s.utmSource != "":
		s.channel = "Campaign"
	default:
		s.channel = "Direct"
	}
	if s.referrer == "" {
		s.referrer = s.utmSource
	}
	return s
}
