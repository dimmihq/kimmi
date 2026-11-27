package main

import (
	"bytes"
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dimmihq/kimmi/internal/auth"
	"github.com/dimmihq/kimmi/internal/bootstrap"
	"github.com/dimmihq/kimmi/internal/store/sqlstore"
)

func TestAdminProjects(t *testing.T) {
	t.Setenv("KIMMI_SECRET", strings.Repeat("s", 40))
	t.Setenv("KIMMI_DATABASE_URL", "sqlite://"+filepath.Join(t.TempDir(), "k.db"))
	t.Setenv("KIMMI_ORG", "dimmi")
	var out bytes.Buffer
	err := runAdmin([]string{"project", "create", "--name", "Production", "--origin", "https://example.com/",
		"--platform", "react", "--origins", "https://example.com, https://*.example.com", "--key", "km_pub_0123456789abcdef"}, &out)
	if err != nil {
		t.Fatal(err)
	}
	var p projectJSON
	if err := json.Unmarshal(out.Bytes(), &p); err != nil {
		t.Fatal(err)
	}
	if p.ID == "" || p.PublicKey != "km_pub_0123456789abcdef" || p.Slug != "production" || len(p.Origins) != 2 || p.Origin != "https://example.com" {
		t.Fatalf("created %+v", p)
	}
	out.Reset()
	if err := runAdmin([]string{"project", "create", "--name", "Docs", "--origin", "https://docs.example.com", "--platform", "astro", "--slug", "the-docs"}, &out); err != nil {
		t.Fatal(err)
	}
	if err := runAdmin([]string{"project", "create", "--name", "Again", "--origin", "https://x.dev", "--platform", "react", "--key", "km_pub_0123456789abcdef"}, &out); err == nil {
		t.Fatal("a taken key was accepted")
	}
	if err := runAdmin([]string{"project", "create", "--name", "Bad", "--origin", "x", "--platform", "cobol"}, &out); err == nil {
		t.Fatal("bad flags accepted")
	}
	out.Reset()
	if err := runAdmin([]string{"project", "list"}, &out); err != nil {
		t.Fatal(err)
	}
	var list []projectJSON
	if err := json.Unmarshal(out.Bytes(), &list); err != nil || len(list) != 2 || list[1].Slug != "the-docs" && list[0].Slug != "the-docs" {
		t.Fatalf("list %s %v", out.String(), err)
	}
}

func TestAdminTokens(t *testing.T) {
	t.Setenv("KIMMI_SECRET", strings.Repeat("s", 40))
	dbURL := "sqlite://" + filepath.Join(t.TempDir(), "k.db")
	t.Setenv("KIMMI_DATABASE_URL", dbURL)
	t.Setenv("KIMMI_ORG", "dimmi")
	var out bytes.Buffer
	err := runAdmin([]string{"token", "create", "--name", "dimmi", "--access", "write"}, &out)
	if err == nil || !strings.Contains(err.Error(), "no owner") {
		t.Fatalf("created a token without an owner: %v", err)
	}
	out.Reset()
	if err := runAdmin([]string{"token", "list"}, &out); err != nil || strings.TrimSpace(out.String()) != "[]" {
		t.Fatalf("empty list %q %v", out.String(), err)
	}

	ctx := context.Background()
	db, err := sqlstore.Open(ctx, dbURL)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := bootstrap.Owner(ctx, db, "dimmi", "ada@acme.dev", "correct horse"); err != nil {
		t.Fatal(err)
	}

	for _, args := range [][]string{{"--access", "write"}, {"--name", "x", "--access", "admin"}, {"--name", "x", "--access", "read", "--expires-days", "4000"}} {
		if err := runAdmin(append([]string{"token", "create"}, args...), &out); err == nil {
			t.Fatalf("%v accepted", args)
		}
	}
	out.Reset()
	if err := runAdmin([]string{"token", "create", "--name", "dimmi", "--access", "write", "--expires-days", "30"}, &out); err != nil {
		t.Fatal(err)
	}
	var tok tokenJSON
	if err := json.Unmarshal(out.Bytes(), &tok); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(tok.Secret, "km_sec_") || tok.Access != "write" || tok.User != "ada@acme.dev" || tok.ExpiresAt == nil {
		t.Fatalf("created %+v", tok)
	}
	stored, err := db.GetAPITokenByHash(ctx, auth.HashToken(tok.Secret))
	if err != nil || stored.ID != tok.ID {
		t.Fatalf("stored %+v %v", stored, err)
	}

	out.Reset()
	if err := runAdmin([]string{"token", "list"}, &out); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out.String(), tok.Secret) || strings.Contains(out.String(), "secret") {
		t.Fatalf("list shows the secret: %s", out.String())
	}
	var list []tokenJSON
	if err := json.Unmarshal(out.Bytes(), &list); err != nil || len(list) != 1 || list[0].ID != tok.ID || list[0].Name != "dimmi" {
		t.Fatalf("list %s %v", out.String(), err)
	}
}
