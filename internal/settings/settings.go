// Package settings defines a project's recording settings: the privacy and
// capture objects the SDK receives from /i/v1/config and the dashboard edits.
package settings

import (
	"encoding/json"
	"fmt"
	"slices"
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

// Settings is the ProjectSettings object of the dashboard API.
type Settings struct {
	Privacy   Privacy   `json:"privacy"`
	Capture   Capture   `json:"capture"`
	Retention Retention `json:"retention"`
}

// Recording is the part stored in projects.settings; retention lives in columns.
type Recording struct {
	Privacy Privacy `json:"privacy"`
	Capture Capture `json:"capture"`
}

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
	}
}

// Decode reads stored recording settings over the defaults, so settings saved
// before a field existed still come back complete.
func Decode(stored []byte, days int, keepStarred bool) Settings {
	s := Default()
	if len(stored) > 0 {
		var r Recording
		r.Privacy, r.Capture = s.Privacy, s.Capture
		if json.Unmarshal(stored, &r) == nil {
			s.Privacy, s.Capture = r.Privacy, r.Capture
		}
	}
	s.Retention = Retention{Days: days, KeepStarred: keepStarred}
	s.normalize()
	return s
}

// Encode returns the JSON stored in projects.settings.
func (s Settings) Encode() []byte {
	b, _ := json.Marshal(Recording{Privacy: s.Privacy, Capture: s.Capture})
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
	if len(fields) == 0 {
		return nil
	}
	return fields
}
