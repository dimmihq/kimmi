package main

import (
	"bytes"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
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
