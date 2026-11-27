package ingest

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/dimmihq/kimmi/internal/settings"
	"github.com/dimmihq/kimmi/internal/store"
)

// Project is what the ingest path knows about a public key.
type Project struct {
	ID       string
	OrgID    string
	Name     string
	Timezone string
	Origins  []string
	// Config is the ready-to-send /i/v1/config body.
	Config   []byte
	Settings settings.Settings
}

// ProjectLister is the one store query the cache needs.
type ProjectLister interface {
	ListAllProjects(ctx context.Context) ([]store.Project, error)
}

// Cache maps public keys to projects so ingest never touches the database
// per request. It reloads every few seconds, and at once when this process
// changes a project.
type Cache struct {
	store ProjectLister
	log   *slog.Logger

	mu    sync.RWMutex
	byKey map[string]*Project
	byID  map[string]*Project
}

// NewCache returns an empty cache; call Load before serving.
func NewCache(s ProjectLister, log *slog.Logger) *Cache {
	return &Cache{store: s, log: log, byKey: map[string]*Project{}, byID: map[string]*Project{}}
}

// Lookup finds the live project with this public key.
func (c *Cache) Lookup(key string) (*Project, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	p, ok := c.byKey[key]
	return p, ok
}

// ByID finds a live project by its id.
func (c *Cache) ByID(id string) (*Project, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	p, ok := c.byID[id]
	return p, ok
}

// Load replaces the cache with the projects in the database.
func (c *Cache) Load(ctx context.Context) error {
	projects, err := c.store.ListAllProjects(ctx)
	if err != nil {
		return fmt.Errorf("load project cache: %w", err)
	}
	next := make(map[string]*Project, len(projects))
	byID := make(map[string]*Project, len(projects))
	for _, p := range projects {
		s := settings.Decode(p.Settings, p.RetentionDays, p.KeepStarred)
		proj := &Project{ID: p.ID, OrgID: p.OrgID, Name: p.Name, Timezone: p.Timezone, Origins: normalizeOrigins(p.Origins),
			Config: configBody(true, s), Settings: s}
		next[p.PublicKey] = proj
		byID[p.ID] = proj
	}
	c.mu.Lock()
	c.byKey, c.byID = next, byID
	c.mu.Unlock()
	return nil
}

// Invalidate reloads at once; the API calls it after changing a project.
func (c *Cache) Invalidate(ctx context.Context) {
	if err := c.Load(ctx); err != nil {
		c.log.Error("reload project cache", "err", err)
	}
}

// Run reloads the cache every interval until ctx ends.
func (c *Cache) Run(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			c.Invalidate(ctx)
		}
	}
}

type configResponse struct {
	Recording  bool              `json:"recording"`
	SampleRate int               `json:"sampleRate"`
	Privacy    settings.Privacy  `json:"privacy"`
	Capture    settings.Capture  `json:"capture"`
	Analytics  analyticsConfig   `json:"analytics"`
	Feedback   settings.Feedback `json:"feedback"`
}

// analyticsConfig is the part of the analytics settings the SDK acts on.
type analyticsConfig struct {
	Enabled    bool `json:"enabled"`
	Cookieless bool `json:"cookieless"`
	AutoEvents bool `json:"autoEvents"`
	Heatmaps   bool `json:"heatmaps"`
}

func configBody(recording bool, s settings.Settings) []byte {
	a := s.Analytics
	b, _ := json.Marshal(configResponse{Recording: recording, SampleRate: s.Capture.SampleRate, Privacy: s.Privacy, Capture: s.Capture,
		Analytics: analyticsConfig{Enabled: recording && a.Enabled, Cookieless: a.Cookieless, AutoEvents: a.AutoEvents, Heatmaps: a.Heatmaps},
		Feedback:  settings.Feedback{Widget: recording && a.Enabled && s.Feedback.Widget}})
	return b
}

// disabledConfig is sent for unknown or deleted keys.
var disabledConfig = configBody(false, settings.Default())

func normalizeOrigins(origins []string) []string {
	out := make([]string, 0, len(origins))
	for _, o := range origins {
		if o = strings.TrimRight(strings.ToLower(strings.TrimSpace(o)), "/"); o != "" {
			out = append(out, o)
		}
	}
	return out
}

// Allows reports whether a request from origin may send data. An empty list
// allows everyone; "https://*.acme.dev" allows every subdomain over https.
func (p *Project) Allows(origin string) bool {
	if len(p.Origins) == 0 {
		return true
	}
	origin = strings.ToLower(origin)
	for _, o := range p.Origins {
		if o == origin {
			return true
		}
		if scheme, host, ok := strings.Cut(o, "://*."); ok && strings.HasPrefix(origin, scheme+"://") &&
			strings.HasSuffix(origin, "."+host) {
			return true
		}
	}
	return false
}
