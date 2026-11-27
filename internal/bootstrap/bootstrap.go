// Package bootstrap prepares an instance at start-up from its environment,
// so it can be deployed declaratively: KIMMI_OWNER creates the first owner,
// KIMMI_BOOTSTRAP creates projects with fixed public keys. Both are safe to
// apply on every start.
package bootstrap

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/dimmihq/kimmi/internal/auth"
	"github.com/dimmihq/kimmi/internal/project"
	"github.com/dimmihq/kimmi/internal/store"
)

// Store is what bootstrapping needs.
type Store interface {
	HasUsers(ctx context.Context) (bool, error)
	FirstOrg(ctx context.Context) (store.Org, error)
	CreateOrg(ctx context.Context, org store.Org) error
	CreateOrgWithOwner(ctx context.Context, org store.Org, owner store.User) error
	CreateUser(ctx context.Context, u store.User) error
	ListAllProjects(ctx context.Context) ([]store.Project, error)
	CreateProject(ctx context.Context, p store.Project) error
}

// Org returns the instance's organisation, creating it with name when
// there is none.
func Org(ctx context.Context, s Store, name string) (store.Org, error) {
	org, err := s.FirstOrg(ctx)
	if err == nil || !errors.Is(err, store.ErrNotFound) {
		return org, err
	}
	org = store.Org{ID: store.NewID(), Name: name, CreatedAt: time.Now().UnixMilli()}
	if err := s.CreateOrg(ctx, org); err != nil {
		return org, err
	}
	return org, nil
}

// Owner creates the owner from KIMMI_OWNER when the database has no users
// yet, and reports whether it did. Once any user exists it does nothing.
func Owner(ctx context.Context, s Store, orgName, email, password string) (bool, error) {
	if email == "" {
		return false, nil
	}
	has, err := s.HasUsers(ctx)
	if err != nil || has {
		return false, err
	}
	hash, err := auth.HashPassword(password)
	if err != nil {
		return false, fmt.Errorf("KIMMI_OWNER: %w", err)
	}
	now := time.Now().UnixMilli()
	name, _, _ := strings.Cut(email, "@")
	u := store.User{ID: store.NewID(), Name: name, Email: email, PasswordHash: hash, Role: store.RoleOwner, CreatedAt: now}
	org, err := s.FirstOrg(ctx)
	switch {
	case errors.Is(err, store.ErrNotFound):
		org = store.Org{ID: store.NewID(), Name: orgName, CreatedAt: now}
		u.OrgID = org.ID
		err = s.CreateOrgWithOwner(ctx, org, u)
	case err == nil:
		u.OrgID = org.ID
		err = s.CreateUser(ctx, u)
	}
	if err != nil {
		return false, fmt.Errorf("KIMMI_OWNER: create the owner: %w", err)
	}
	return true, nil
}

// File is the KIMMI_BOOTSTRAP document.
type File struct {
	Projects []project.Spec `json:"projects"`
}

// Load reads and checks a bootstrap file. Every project needs a fixed
// publicKey and slug, so applying the file again finds the same projects.
func Load(path string) (File, error) {
	var f File
	data, err := os.ReadFile(path)
	if err != nil {
		return f, fmt.Errorf("KIMMI_BOOTSTRAP: %w", err)
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&f); err != nil {
		return f, fmt.Errorf("KIMMI_BOOTSTRAP %s: not a valid bootstrap file: %w", path, err)
	}
	var problems []string
	keys, slugs := map[string]bool{}, map[string]bool{}
	for i, p := range f.Projects {
		where := fmt.Sprintf("projects[%d]", i)
		if p.Slug == "" {
			problems = append(problems, where+".slug: required")
		}
		if p.PublicKey == "" {
			problems = append(problems, where+".publicKey: required")
		}
		if _, fields := project.Build("", p); len(fields) > 0 {
			names := make([]string, 0, len(fields))
			for k := range fields {
				names = append(names, k)
			}
			sort.Strings(names)
			for _, k := range names {
				problems = append(problems, fmt.Sprintf("%s.%s: %s", where, k, fields[k]))
			}
		}
		if keys[p.PublicKey] && p.PublicKey != "" {
			problems = append(problems, where+".publicKey: used twice in the file")
		}
		if slugs[p.Slug] && p.Slug != "" {
			problems = append(problems, where+".slug: used twice in the file")
		}
		keys[p.PublicKey], slugs[p.Slug] = true, true
	}
	if len(problems) > 0 {
		return f, fmt.Errorf("KIMMI_BOOTSTRAP %s:\n  %s", path, strings.Join(problems, "\n  "))
	}
	return f, nil
}

// Result says what Apply did.
type Result struct {
	Created, Kept []string // slugs
}

// Apply creates the file's projects that do not exist yet in the instance's
// organisation (created with orgName when missing). A project whose public
// key exists is left exactly as it is, so changes made in the dashboard
// survive a restart. A slug that exists with another key is an error: a
// key is never changed here.
func Apply(ctx context.Context, s Store, orgName string, f File) (Result, error) {
	var res Result
	if len(f.Projects) == 0 {
		return res, nil
	}
	org, err := Org(ctx, s, orgName)
	if err != nil {
		return res, fmt.Errorf("KIMMI_BOOTSTRAP: %w", err)
	}
	existing, err := s.ListAllProjects(ctx)
	if err != nil {
		return res, fmt.Errorf("KIMMI_BOOTSTRAP: %w", err)
	}
	byKey, bySlug := map[string]store.Project{}, map[string]store.Project{}
	for _, p := range existing {
		byKey[p.PublicKey] = p
		if p.OrgID == org.ID {
			bySlug[p.Slug] = p
		}
	}
	for _, spec := range f.Projects {
		if p, ok := byKey[spec.PublicKey]; ok {
			if p.OrgID != org.ID {
				return res, fmt.Errorf("KIMMI_BOOTSTRAP: public key of project %q belongs to another organisation", spec.Slug)
			}
			res.Kept = append(res.Kept, p.Slug)
			continue
		}
		if p, ok := bySlug[spec.Slug]; ok {
			return res, fmt.Errorf("KIMMI_BOOTSTRAP: project %q already exists with public key %s, not %s; "+
				"kimmi never changes a key from the bootstrap file: put the existing key in the file, or rename the slug",
				spec.Slug, p.PublicKey, spec.PublicKey)
		}
		p, fields := project.Build(org.ID, spec)
		if len(fields) > 0 {
			return res, fmt.Errorf("KIMMI_BOOTSTRAP: project %q is not valid: %v", spec.Slug, fields)
		}
		if _, err := project.Create(ctx, s, p); err != nil {
			if errors.Is(err, store.ErrConflict) {
				return res, fmt.Errorf("KIMMI_BOOTSTRAP: project %q: its slug or public key is already taken", spec.Slug)
			}
			return res, fmt.Errorf("KIMMI_BOOTSTRAP: project %q: %w", spec.Slug, err)
		}
		res.Created = append(res.Created, spec.Slug)
	}
	return res, nil
}
