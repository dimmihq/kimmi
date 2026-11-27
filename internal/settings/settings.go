// Package settings defines a project's recording settings: the privacy and
// capture objects the SDK receives from /i/v1/config and the dashboard edits.
package settings

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"slices"
	"strings"
)

// Privacy controls what the SDK masks and blocks.
type Privacy struct {
	MaskAllText     bool     `json:"maskAllText"`
	MaskAllInputs   bool     `json:"maskAllInputs"`
	BlockMedia      bool     `json:"blockMedia"`
	RecordCanvas    bool     `json:"recordCanvas"`
	MaskSelectors   []string `json:"maskSelectors"`
	BlockSelectors  []string `json:"blockSelectors"`
	IgnoreSelectors []string `json:"ignoreSelectors"`
	RespectDnt      bool     `json:"respectDnt"`
	RequireConsent  bool     `json:"requireConsent"`
	IP              string   `json:"ip"`
	// ScrubEmails and ScrubPhones make the SDK replace email addresses and
	// phone numbers in console, network, error and URL text before sending.
	ScrubEmails bool `json:"scrubEmails"`
	ScrubPhones bool `json:"scrubPhones"`
}

// URLRule limits recording to matching pages.
type URLRule struct {
	Type    string `json:"type"`
	Pattern string `json:"pattern"`
}

// Capture controls what the SDK records and when.
type Capture struct {
	SampleRate         int       `json:"sampleRate"`
	Console            bool      `json:"console"`
	Network            bool      `json:"network"`
	NetworkBodies      bool      `json:"networkBodies"`
	Performance        bool      `json:"performance"`
	Frustration        bool      `json:"frustration"`
	CrossOriginIframes bool      `json:"crossOriginIframes"`
	StartOnError       bool      `json:"startOnError"`
	MinDurationMs      int64     `json:"minDurationMs"`
	IdleTimeoutMs      int64     `json:"idleTimeoutMs"`
	MaxLengthMs        int64     `json:"maxLengthMs"`
	URLRules           []URLRule `json:"urlRules"`
}

// Retention says how long recordings are kept.
type Retention struct {
	Days        int  `json:"days"`
	KeepStarred bool `json:"keepStarred"`
}

// Step is one goal or funnel step: a page (Value is a path, or a prefix
// ending in *) or a tracked event (Value is its name).
type Step struct {
	Kind  string `json:"kind"`
	Value string `json:"value"`
}

// Goal is something a visit can reach, counted as a conversion.
type Goal struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Step
}

// Funnel is an ordered list of steps.
type Funnel struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Steps []Step `json:"steps"`
}

// Analytics controls visit counting, which runs beside recording. It is
// off until a project turns it on: a project that only records stays as
// simple as it was.
type Analytics struct {
	Enabled bool `json:"enabled"`
	// Cookieless counts visits without storing anything in the browser;
	// recording then waits for kimmi.optIn().
	Cookieless bool `json:"cookieless"`
	// AutoEvents tracks outbound links, downloads, email and phone links
	// and form submissions without code.
	AutoEvents bool `json:"autoEvents"`
	// Heatmaps records where clicks land.
	Heatmaps      bool     `json:"heatmaps"`
	RetentionDays int      `json:"retentionDays"`
	Goals         []Goal   `json:"goals"`
	Funnels       []Funnel `json:"funnels"`
}

// Feedback controls the feedback button on the site.
type Feedback struct {
	// Button is where the button sits: "hidden" (the site calls
	// kimmi.feedback itself), "bottom-right" or "bottom-left".
	Button string `json:"button"`
}

// FeedbackButtons are the allowed places of the feedback button.
var FeedbackButtons = []string{"hidden", "bottom-right", "bottom-left"}

// Alerts sends events to one webhook. Nothing is sent without a URL.
type Alerts struct {
	WebhookURL string `json:"webhookUrl"`
	// Secret signs each delivery (X-Kimmi-Signature) when set.
	Secret       string `json:"secret"`
	NewErrors    bool   `json:"newErrors"`
	ErrorSpike   int    `json:"errorSpike"` // errors in an hour; 0 is off
	RageSpike    int    `json:"rageSpike"`  // rage clicks in an hour; 0 is off
	NoTraffic    bool   `json:"noTraffic"`
	Feedback     bool   `json:"feedback"`
	WeeklyDigest bool   `json:"weeklyDigest"`
}

// Sharing allows public links to recordings and to the analytics page.
type Sharing struct {
	Enabled bool `json:"enabled"`
}

// Settings is the ProjectSettings object of the dashboard API.
type Settings struct {
	Privacy   Privacy   `json:"privacy"`
	Capture   Capture   `json:"capture"`
	Retention Retention `json:"retention"`
	Analytics Analytics `json:"analytics"`
	Feedback  Feedback  `json:"feedback"`
	Alerts    Alerts    `json:"alerts"`
	Sharing   Sharing   `json:"sharing"`
}

// Recording is the part stored in projects.settings; retention lives in columns.
type Recording struct {
	Privacy   Privacy   `json:"privacy"`
	Capture   Capture   `json:"capture"`
	Analytics Analytics `json:"analytics"`
	Feedback  Feedback  `json:"feedback"`
	Alerts    Alerts    `json:"alerts"`
	Sharing   Sharing   `json:"sharing"`
}

// AnalyticsDays are the allowed analytics retention periods.
var AnalyticsDays = []int{30, 90, 365, 730}

// RetentionDays are the allowed retention periods.
var RetentionDays = []int{7, 30, 90, 365}

// Default returns the settings of a new project.
func Default() Settings {
	return Settings{
		Privacy: Privacy{MaskAllInputs: true, IP: "truncate", ScrubEmails: true, ScrubPhones: true,
			MaskSelectors: []string{}, BlockSelectors: []string{}, IgnoreSelectors: []string{}},
		Capture: Capture{SampleRate: 100, Console: true, Network: true, Performance: true, Frustration: true,
			MinDurationMs: 2000, IdleTimeoutMs: 900000, MaxLengthMs: 3600000, URLRules: []URLRule{}},
		Retention: Retention{Days: 30, KeepStarred: true},
		Analytics: Analytics{AutoEvents: true, Heatmaps: true, RetentionDays: 365, Goals: []Goal{}, Funnels: []Funnel{}},
		Feedback:  Feedback{Button: "hidden"},
		Alerts:    Alerts{NewErrors: true, ErrorSpike: 10, RageSpike: 10, Feedback: true, WeeklyDigest: true},
	}
}

// Decode reads stored recording settings over the defaults, so settings saved
// before a field existed still come back complete.
func Decode(stored []byte, days int, keepStarred bool) Settings {
	s := Default()
	if len(stored) > 0 {
		r := Recording{Privacy: s.Privacy, Capture: s.Capture, Analytics: s.Analytics, Feedback: s.Feedback, Alerts: s.Alerts, Sharing: s.Sharing}
		if json.Unmarshal(stored, &r) == nil {
			s.Privacy, s.Capture, s.Analytics, s.Feedback, s.Alerts, s.Sharing = r.Privacy, r.Capture, r.Analytics, r.Feedback, r.Alerts, r.Sharing
		}
	}
	s.Retention = Retention{Days: days, KeepStarred: keepStarred}
	s.normalize()
	return s
}

// Encode returns the JSON stored in projects.settings.
func (s Settings) Encode() []byte {
	b, _ := json.Marshal(Recording{Privacy: s.Privacy, Capture: s.Capture, Analytics: s.Analytics, Feedback: s.Feedback, Alerts: s.Alerts, Sharing: s.Sharing})
	return b
}

func (s *Settings) normalize() {
	for _, list := range []*[]string{&s.Privacy.MaskSelectors, &s.Privacy.BlockSelectors, &s.Privacy.IgnoreSelectors} {
		if *list == nil {
			*list = []string{}
		}
	}
	if s.Capture.URLRules == nil {
		s.Capture.URLRules = []URLRule{}
	}
	if s.Analytics.Goals == nil {
		s.Analytics.Goals = []Goal{}
	}
	if s.Analytics.Funnels == nil {
		s.Analytics.Funnels = []Funnel{}
	}
	for i := range s.Analytics.Goals {
		g := &s.Analytics.Goals[i]
		g.Name, g.Value = strings.TrimSpace(g.Name), strings.TrimSpace(g.Value)
		if g.ID == "" {
			g.ID = newID()
		}
	}
	for i := range s.Analytics.Funnels {
		f := &s.Analytics.Funnels[i]
		f.Name = strings.TrimSpace(f.Name)
		if f.ID == "" {
			f.ID = newID()
		}
		if f.Steps == nil {
			f.Steps = []Step{}
		}
		for j := range f.Steps {
			f.Steps[j].Value = strings.TrimSpace(f.Steps[j].Value)
		}
	}
	s.Alerts.WebhookURL = strings.TrimSpace(s.Alerts.WebhookURL)
	if s.Feedback.Button == "" {
		s.Feedback.Button = "hidden"
	}
}

// newID names a goal or funnel: 8 random hex digits.
func newID() string {
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func (st Step) problem() string {
	switch {
	case st.Kind != "page" && st.Kind != "event":
		return "Choose a page or an event"
	case st.Value == "":
		return "Required"
	case len(st.Value) > 200:
		return "At most 200 characters"
	case st.Kind == "page" && !strings.HasPrefix(st.Value, "/"):
		return "A path starts with /"
	}
	return ""
}

// Merge deep-merges a partial settings object into s and validates the result.
// It returns field errors keyed by dotted path, like "retention.days".
func (s Settings) Merge(patch json.RawMessage) (Settings, map[string]string, error) {
	var base map[string]any
	cur, _ := json.Marshal(s)
	_ = json.Unmarshal(cur, &base)
	var p map[string]any
	if err := json.Unmarshal(patch, &p); err != nil {
		return s, nil, fmt.Errorf("settings must be a JSON object: %w", err)
	}
	mergeMaps(base, p)
	merged, _ := json.Marshal(base)
	var out Settings
	if err := json.Unmarshal(merged, &out); err != nil {
		return s, nil, fmt.Errorf("settings have the wrong shape: %w", err)
	}
	out.normalize()
	return out, out.validate(), nil
}

func mergeMaps(dst, src map[string]any) {
	for k, v := range src {
		if sub, ok := v.(map[string]any); ok {
			if d, ok := dst[k].(map[string]any); ok {
				mergeMaps(d, sub)
				continue
			}
		}
		dst[k] = v
	}
}

func (s Settings) validate() map[string]string {
	fields := map[string]string{}
	if !slices.Contains(RetentionDays, s.Retention.Days) {
		fields["retention.days"] = "Must be 7, 30, 90 or 365"
	}
	if s.Capture.SampleRate < 0 || s.Capture.SampleRate > 100 {
		fields["capture.sampleRate"] = "Must be between 0 and 100"
	}
	if !slices.Contains([]string{"full", "truncate", "none"}, s.Privacy.IP) {
		fields["privacy.ip"] = "Must be full, truncate or none"
	}
	for _, d := range []struct {
		key string
		v   int64
	}{{"capture.minDurationMs", s.Capture.MinDurationMs}, {"capture.idleTimeoutMs", s.Capture.IdleTimeoutMs}, {"capture.maxLengthMs", s.Capture.MaxLengthMs}} {
		if d.v < 0 {
			fields[d.key] = "Must not be negative"
		}
	}
	for i, r := range s.Capture.URLRules {
		if (r.Type != "contains" && r.Type != "matches") || r.Pattern == "" {
			fields[fmt.Sprintf("capture.urlRules.%d", i)] = "Needs a type (contains or matches) and a pattern"
		}
	}
	if !slices.Contains(AnalyticsDays, s.Analytics.RetentionDays) {
		fields["analytics.retentionDays"] = "Must be 30, 90, 365 or 730"
	}
	if len(s.Analytics.Goals) > 20 {
		fields["analytics.goals"] = "At most 20 goals"
	}
	for i, g := range s.Analytics.Goals {
		if g.Name == "" || len(g.Name) > 60 {
			fields[fmt.Sprintf("analytics.goals.%d.name", i)] = "Needs a name of at most 60 characters"
		}
		if p := g.Step.problem(); p != "" {
			fields[fmt.Sprintf("analytics.goals.%d.value", i)] = p
		}
	}
	if len(s.Analytics.Funnels) > 10 {
		fields["analytics.funnels"] = "At most 10 funnels"
	}
	for i, f := range s.Analytics.Funnels {
		if f.Name == "" || len(f.Name) > 60 {
			fields[fmt.Sprintf("analytics.funnels.%d.name", i)] = "Needs a name of at most 60 characters"
		}
		if len(f.Steps) < 2 || len(f.Steps) > 6 {
			fields[fmt.Sprintf("analytics.funnels.%d.steps", i)] = "A funnel has 2 to 6 steps"
		}
		for j, st := range f.Steps {
			if p := st.problem(); p != "" {
				fields[fmt.Sprintf("analytics.funnels.%d.steps.%d", i, j)] = p
			}
		}
	}
	if u := s.Alerts.WebhookURL; u != "" {
		parsed, err := url.Parse(u)
		if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || len(u) > 2000 {
			fields["alerts.webhookUrl"] = "Must be an http or https URL"
		}
	}
	if !slices.Contains(FeedbackButtons, s.Feedback.Button) {
		fields["feedback.button"] = "Must be hidden, bottom-right or bottom-left"
	}
	if len(s.Alerts.Secret) > 200 {
		fields["alerts.secret"] = "At most 200 characters"
	}
	if s.Alerts.ErrorSpike < 0 || s.Alerts.ErrorSpike > 100000 {
		fields["alerts.errorSpike"] = "Must be between 0 and 100000"
	}
	if s.Alerts.RageSpike < 0 || s.Alerts.RageSpike > 100000 {
		fields["alerts.rageSpike"] = "Must be between 0 and 100000"
	}
	if len(fields) == 0 {
		return nil
	}
	return fields
}
