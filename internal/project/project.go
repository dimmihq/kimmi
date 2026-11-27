// Package project validates and creates projects. The dashboard API, the
// admin commands and the start-up bootstrap share it, so a project made any
// of these ways follows the same rules.
package project

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/dimmihq/kimmi/internal/auth"
	"github.com/dimmihq/kimmi/internal/settings"
	"github.com/dimmihq/kimmi/internal/store"
)

// Platforms are the accepted platform names.
var Platforms = []string{"react", "next", "vue", "astro", "svelte", "script"}

var (
	slugPattern = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)
	keyPattern  = regexp.MustCompile(`^` + auth.PublicKeyPrefix + `[0-9a-f]{16}$`)
)

// ValidPlatform reports whether p is a platform name.
func ValidPlatform(p string) bool { return slices.Contains(Platforms, p) }

// ValidSlug reports whether s is a project slug.
func ValidSlug(s string) bool { return len(s) <= 64 && slugPattern.MatchString(s) }

// ValidPublicKey reports whether k looks like a key kimmi generates:
// km_pub_ and 16 lowercase hex digits.
func ValidPublicKey(k string) bool { return keyPattern.MatchString(k) }

// ValidOrigin reports whether o is a site origin like https://acme.dev.
func ValidOrigin(o string) bool {
	u, err := url.Parse(o)
	return err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != "" && (u.Path == "" || u.Path == "/") &&
		u.RawQuery == "" && u.Fragment == "" && u.User == nil
}

// ValidOriginPattern also accepts a wildcard subdomain: https://*.acme.dev.
func ValidOriginPattern(o string) bool { return ValidOrigin(strings.Replace(o, "://*.", "://", 1)) }

// CleanOrigin trims spaces and a trailing slash.
func CleanOrigin(o string) string { return strings.TrimRight(strings.TrimSpace(o), "/") }

// Slugify turns a name into a slug.
func Slugify(name string) string {
	var b strings.Builder
	dash := false
	for _, c := range strings.ToLower(name) {
		switch {
		case c >= 'a' && c <= 'z' || c >= '0' && c <= '9':
			b.WriteRune(c)
			dash = false
		case !dash && b.Len() > 0:
			b.WriteByte('-')
			dash = true
		}
	}
	s := strings.TrimSuffix(b.String(), "-")
	if len(s) > 60 {
		s = strings.TrimSuffix(s[:60], "-")
	}
	if s == "" {
		s = "project"
	}
	return s
}

// Spec describes a project to create. Slug and PublicKey may be empty, and
// are then generated; when set they are used exactly. Settings is an
// optional partial ProjectSettings, deep-merged over the defaults.
type Spec struct {
	Name      string          `json:"name"`
	Slug      string          `json:"slug"`
	Platform  string          `json:"platform"`
	Origin    string          `json:"origin"`
	Origins   []string        `json:"origins"`
	PublicKey string          `json:"publicKey"`
	Settings  json.RawMessage `json:"settings"`
}

// Build validates s and returns the project it describes in org orgID, or
// the problems per field.
func Build(orgID string, s Spec) (store.Project, map[string]string) {
	fields := map[string]string{}
	name := strings.TrimSpace(s.Name)
	if name == "" {
		fields["name"] = "Required"
	}
	origin := CleanOrigin(s.Origin)
	if !ValidOrigin(origin) {
		fields["origin"] = "A site address like https://acme.dev"
	}
	if !ValidPlatform(s.Platform) {
		fields["platform"] = "Must be one of " + strings.Join(Platforms, ", ")
	}
	if s.Slug != "" && !ValidSlug(s.Slug) {
		fields["slug"] = "Lowercase letters, digits and dashes"
	}
	if s.PublicKey != "" && !ValidPublicKey(s.PublicKey) {
		fields["publicKey"] = "km_pub_ followed by 16 lowercase hex digits"
	}
	origins := []string{}
	for i, o := range s.Origins {
		o = CleanOrigin(o)
		if !ValidOriginPattern(o) {
			fields[fmt.Sprintf("origins.%d", i)] = "An origin like https://acme.dev or https://*.acme.dev"
		}
		if !slices.Contains(origins, o) {
			origins = append(origins, o)
		}
	}
	set := settings.Default()
	if len(s.Settings) > 0 && string(s.Settings) != "null" {
		next, bad, err := set.Merge(s.Settings)
		switch {
		case err != nil:
			fields["settings"] = err.Error()
		case bad != nil:
			for k, v := range bad {
				fields["settings."+k] = v
			}
		default:
			set = next
		}
	}
	if len(fields) > 0 {
		return store.Project{}, fields
	}
	return store.Project{ID: store.NewID(), OrgID: orgID, Name: name, Slug: s.Slug, Platform: s.Platform, Origin: origin,
		Timezone: "UTC", PublicKey: s.PublicKey, Origins: origins, Settings: set.Encode(), RetentionDays: set.Retention.Days,
		KeepStarred: set.Retention.KeepStarred, CreatedAt: time.Now().UnixMilli()}, nil
}

// Creator is the store method Create needs.
type Creator interface {
	CreateProject(ctx context.Context, p store.Project) error
}

// Create stores p. An empty slug is taken from the name and an empty key
// generated; when either is taken, Create retries with a numbered slug and
// a new key. A slug or key that was given is never changed: a conflict on
// it returns store.ErrConflict.
func Create(ctx context.Context, st Creator, p store.Project) (store.Project, error) {
	fixedSlug, fixedKey := p.Slug != "", p.PublicKey != ""
	base := p.Slug
	if !fixedSlug {
		base = Slugify(p.Name)
	}
	var err error
	for i := 1; i <= 20; i++ {
		if !fixedSlug {
			p.Slug = base
			if i > 1 {
				p.Slug = fmt.Sprintf("%s-%d", base, i)
			}
		}
		if !fixedKey {
			p.PublicKey = auth.NewPublicKey()
		}
		if err = st.CreateProject(ctx, p); !errors.Is(err, store.ErrConflict) || fixedSlug {
			break
		}
	}
	return p, err
}
