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

func runAdmin(args []string, out io.Writer) error {
	if len(args) < 2 || args[0] != "project" || (args[1] != "list" && args[1] != "create") {
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
