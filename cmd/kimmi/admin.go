package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/dimmihq/kimmi/internal/auth"
	"github.com/dimmihq/kimmi/internal/bootstrap"
	"github.com/dimmihq/kimmi/internal/config"
	"github.com/dimmihq/kimmi/internal/project"
	"github.com/dimmihq/kimmi/internal/store"
	"github.com/dimmihq/kimmi/internal/store/sqlstore"
)

const adminUsage = `Usage:
  kimmi admin project list
      print every project as JSON
  kimmi admin project create --name NAME --origin URL --platform PLATFORM
                             [--origins a,b] [--slug SLUG] [--key km_pub_...]
      create a project in the instance's organisation and print it as JSON
  kimmi admin token list
      print every API token as JSON, without secrets
  kimmi admin token create --name NAME --access read|write [--expires-days N]
      create an API token owned by the organisation's owner and print it as
      JSON with its secret, which is shown only this once

The admin commands read the same KIMMI_* environment as kimmi serve and
work on the database directly.
`

// projectJSON is how the admin commands print a project.
type projectJSON struct {
	ID            string   `json:"id"`
	Name          string   `json:"name"`
	Slug          string   `json:"slug"`
	Platform      string   `json:"platform"`
	Origin        string   `json:"origin"`
	Origins       []string `json:"origins"`
	PublicKey     string   `json:"publicKey"`
	RetentionDays int      `json:"retentionDays"`
	CreatedAt     int64    `json:"createdAt"`
}

func toJSON(p store.Project) projectJSON {
	return projectJSON{ID: p.ID, Name: p.Name, Slug: p.Slug, Platform: p.Platform, Origin: p.Origin, Origins: p.Origins,
		PublicKey: p.PublicKey, RetentionDays: p.RetentionDays, CreatedAt: p.CreatedAt}
}

// tokenJSON is how the admin commands print an API token.
type tokenJSON struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Prefix     string `json:"prefix"`
	Access     string `json:"access"`
	User       string `json:"user"`
	CreatedAt  int64  `json:"createdAt"`
	LastUsedAt *int64 `json:"lastUsedAt"`
	ExpiresAt  *int64 `json:"expiresAt"`
	Secret     string `json:"secret,omitempty"`
}

func toTokenJSON(t store.APIToken, user string) tokenJSON {
	return tokenJSON{ID: t.ID, Name: t.Name, Prefix: t.Prefix, Access: t.Access, User: user, CreatedAt: t.CreatedAt,
		LastUsedAt: t.LastUsedAt, ExpiresAt: t.ExpiresAt}
}

func runAdmin(args []string, out io.Writer) error {
	known := len(args) >= 2 && (args[0] == "project" || args[0] == "token") && (args[1] == "list" || args[1] == "create")
	if !known {
		fmt.Fprint(os.Stderr, adminUsage)
		if len(args) > 0 && (args[0] == "-h" || args[0] == "--help" || args[0] == "help") {
			return nil
		}
		return errors.New("admin: unknown command")
	}
	cfg, err := config.Load(os.Getenv)
	if err != nil {
		return err
	}
	ctx := context.Background()
	db, err := sqlstore.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer db.Close()
	enc := json.NewEncoder(out)
	enc.SetIndent("", "  ")
	switch {
	case args[0] == "token" && args[1] == "list":
		return listTokens(ctx, db, enc)
	case args[0] == "token":
		return createToken(ctx, db, enc, args[2:])
	}
	if args[1] == "list" {
		projects, err := db.ListAllProjects(ctx)
		if err != nil {
			return err
		}
		list := make([]projectJSON, 0, len(projects))
		for _, p := range projects {
			list = append(list, toJSON(p))
		}
		return enc.Encode(list)
	}

	fs := flag.NewFlagSet("admin project create", flag.ContinueOnError)
	var spec project.Spec
	var origins string
	fs.StringVar(&spec.Name, "name", "", "project name (required)")
	fs.StringVar(&spec.Origin, "origin", "", "the site's address, like https://example.com (required)")
	fs.StringVar(&spec.Platform, "platform", "", "one of "+strings.Join(project.Platforms, ", ")+" (required)")
	fs.StringVar(&origins, "origins", "", "comma-separated origins allowed to send data (default: any)")
	fs.StringVar(&spec.Slug, "slug", "", "slug (default: from the name)")
	fs.StringVar(&spec.PublicKey, "key", "", "public key km_pub_ + 16 hex digits (default: generated)")
	if err := fs.Parse(args[2:]); err != nil {
		return err
	}
	for _, o := range strings.Split(origins, ",") {
		if o = strings.TrimSpace(o); o != "" {
			spec.Origins = append(spec.Origins, o)
		}
	}
	org, err := bootstrap.Org(ctx, db, cfg.Org)
	if err != nil {
		return err
	}
	p, fields := project.Build(org.ID, spec)
	if len(fields) > 0 {
		var b strings.Builder
		for k, v := range fields {
			fmt.Fprintf(&b, "\n  --%s: %s", k, v)
		}
		return errors.New("admin: check the flags:" + b.String())
	}
	p, err = project.Create(ctx, db, p)
	if errors.Is(err, store.ErrConflict) {
		return errors.New("admin: a project with this slug or key already exists")
	}
	if err != nil {
		return err
	}
	return enc.Encode(toJSON(p))
}

func listTokens(ctx context.Context, db *sqlstore.DB, enc *json.Encoder) error {
	list := []tokenJSON{}
	org, err := db.FirstOrg(ctx)
	if errors.Is(err, store.ErrNotFound) {
		return enc.Encode(list)
	}
	if err != nil {
		return err
	}
	users, err := db.ListUsers(ctx, org.ID)
	if err != nil {
		return err
	}
	for _, u := range users {
		tokens, err := db.ListAPITokens(ctx, org.ID, u.ID)
		if err != nil {
			return err
		}
		for _, t := range tokens {
			list = append(list, toTokenJSON(t, u.Email))
		}
	}
	return enc.Encode(list)
}

func createToken(ctx context.Context, db *sqlstore.DB, enc *json.Encoder, args []string) error {
	fs := flag.NewFlagSet("admin token create", flag.ContinueOnError)
	var name, access string
	var days int
	fs.StringVar(&name, "name", "", "token name (required)")
	fs.StringVar(&access, "access", "", "read or write (required)")
	fs.IntVar(&days, "expires-days", 0, "days until the token expires, 1 to 3650 (default: never)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	var bad []string
	if name = strings.TrimSpace(name); name == "" {
		bad = append(bad, "--name: required")
	}
	if access != "read" && access != "write" {
		bad = append(bad, "--access: must be read or write")
	}
	if days < 0 || days > 3650 {
		bad = append(bad, "--expires-days: between 1 and 3650")
	}
	if len(bad) > 0 {
		return errors.New("admin: check the flags:\n  " + strings.Join(bad, "\n  "))
	}
	owner, err := firstOwner(ctx, db)
	if err != nil {
		return err
	}
	now := time.Now()
	secret := auth.NewToken()
	t := store.APIToken{ID: store.NewID(), OrgID: owner.OrgID, UserID: owner.ID, Name: name,
		Prefix: auth.TokenDisplayPrefix(secret), TokenHash: auth.HashToken(secret), Access: access, CreatedAt: now.UnixMilli()}
	if days > 0 {
		exp := now.AddDate(0, 0, days).UnixMilli()
		t.ExpiresAt = &exp
	}
	if err := db.CreateAPIToken(ctx, t); err != nil {
		return err
	}
	j := toTokenJSON(t, owner.Email)
	j.Secret = secret
	return enc.Encode(j)
}

// firstOwner is the organisation's oldest owner, who API tokens made here
// belong to.
func firstOwner(ctx context.Context, db *sqlstore.DB) (store.User, error) {
	noOwner := errors.New("admin: the organisation has no owner yet; sign up in the dashboard or set KIMMI_OWNER first")
	org, err := db.FirstOrg(ctx)
	if errors.Is(err, store.ErrNotFound) {
		return store.User{}, noOwner
	}
	if err != nil {
		return store.User{}, err
	}
	users, err := db.ListUsers(ctx, org.ID)
	if err != nil {
		return store.User{}, err
	}
	for _, u := range users {
		if u.Role == store.RoleOwner {
			return u, nil
		}
	}
	return store.User{}, noOwner
}
