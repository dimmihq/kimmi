package config

import (
	"slices"
	"strings"
	"testing"
	"time"
)

func env(m map[string]string) func(string) string { return func(k string) string { return m[k] } }

func TestDefaults(t *testing.T) {
	c, err := Load(env(map[string]string{"KIMMI_SECRET": strings.Repeat("x", 32)}))
	if err != nil {
		t.Fatal(err)
	}
	if c.HTTPAddr != ":8700" || c.DatabaseURL != "sqlite://./data/kimmi.db" || c.Storage != "local" ||
		c.FlushInterval != 2*time.Second || c.SessionIdle != 30*time.Minute || c.LiveWindow != 45*time.Second ||
		!slices.Equal(c.Roles, []string{RoleIngest, RoleAPI, RoleWorker}) || c.Signups != "open" {
		t.Fatalf("defaults %+v", c)
	}
}

func TestRoles(t *testing.T) {
	c, err := Load(env(map[string]string{"KIMMI_SECRET": strings.Repeat("x", 32), "KIMMI_ROLES": "api, worker,api"}))
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(c.Roles, []string{RoleAPI, RoleWorker}) || c.Has(RoleIngest) {
		t.Fatalf("roles %v", c.Roles)
	}
}

func TestReportsEveryProblem(t *testing.T) {
	_, err := Load(env(map[string]string{
		"KIMMI_SECRET": "short", "KIMMI_STORAGE": "s3", "KIMMI_ROLES": "web", "KIMMI_FLUSH_INTERVAL": "soon",
		"KIMMI_DATABASE_URL": "mysql://x", "KIMMI_SIGNUPS": "maybe",
	}))
	if err == nil {
		t.Fatal("accepted a broken configuration")
	}
	for _, want := range []string{"KIMMI_SECRET", "KIMMI_S3_BUCKET", "KIMMI_ROLES", "KIMMI_FLUSH_INTERVAL", "KIMMI_DATABASE_URL", "KIMMI_SIGNUPS"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error does not mention %s:\n%v", want, err)
		}
	}
}

func TestSplitDatabaseURL(t *testing.T) {
	if d, a, err := SplitDatabaseURL("sqlite:///var/lib/kimmi.db"); d != "sqlite" || a != "/var/lib/kimmi.db" || err != nil {
		t.Fatal(d, a, err)
	}
	if d, a, err := SplitDatabaseURL("postgres://u:p@h/db"); d != "postgres" || a != "postgres://u:p@h/db" || err != nil {
		t.Fatal(d, a, err)
	}
	if _, _, err := SplitDatabaseURL("sqlite://"); err == nil {
		t.Fatal("empty sqlite path accepted")
	}
}

func TestLimitsAndMemory(t *testing.T) {
	base := map[string]string{"KIMMI_SECRET": strings.Repeat("x", 32)}
	c, err := Load(env(base))
	if err != nil {
		t.Fatal(err)
	}
	if c.MemoryLimit != 256<<20 || c.IngestBuffer != 64<<20 || c.IngestProjectBuffer != 32<<20 ||
		c.IngestRate != 20 || c.IngestBurst != 60 || c.AuthRate != 10 || c.AuthBurst != 10 ||
		c.DebugAddr != "" || len(c.TrustedProxies) != 0 || c.Org != "kimmi" || c.Secure() {
		t.Fatalf("defaults %+v", c)
	}
	base["GOMEMLIMIT"] = "1GiB"
	base["KIMMI_MEMORY_LIMIT"] = "64MiB"
	base["KIMMI_INGEST_RATE"] = "0"
	base["KIMMI_INGEST_BUFFER"] = "64MB"
	base["KIMMI_TRUSTED_PROXIES"] = "10.0.0.0/8, 192.168.1.7 ,fd00::/8"
	base["KIMMI_PUBLIC_URL"] = "https://replay.example.com"
	c, err = Load(env(base))
	if err != nil {
		t.Fatal(err)
	}
	if c.MemoryLimit != 0 || c.IngestRate != 0 || c.IngestBuffer != 64e6 || c.IngestProjectBuffer != 32e6 ||
		len(c.TrustedProxies) != 3 || c.TrustedProxies[1].String() != "192.168.1.7/32" || !c.Secure() {
		t.Fatalf("parsed %+v", c)
	}
	for _, bad := range []map[string]string{
		{"KIMMI_MEMORY_LIMIT": "lots"}, {"KIMMI_INGEST_RATE": "-1"}, {"KIMMI_TRUSTED_PROXIES": "10.0.0.0/99"},
		{"KIMMI_INGEST_BUFFER": "1KiB"},
	} {
		bad["KIMMI_SECRET"] = strings.Repeat("x", 32)
		if _, err := Load(env(bad)); err == nil {
			t.Errorf("accepted %v", bad)
		}
	}
}

func TestOwnerVariable(t *testing.T) {
	c, err := Load(env(map[string]string{"KIMMI_SECRET": strings.Repeat("x", 32),
		"KIMMI_OWNER": "Ops@Example.com:pass:with:colons", "KIMMI_ORG": "dimmi"}))
	if err != nil || c.OwnerEmail != "ops@example.com" || c.OwnerPassword != "pass:with:colons" || c.Org != "dimmi" {
		t.Fatalf("%+v %v", c, err)
	}
	for _, v := range []string{"nobody", "ops@example.com", "ops@example.com:short", ":longenough"} {
		_, err := Load(env(map[string]string{"KIMMI_SECRET": strings.Repeat("x", 32), "KIMMI_OWNER": v}))
		if err == nil {
			t.Errorf("KIMMI_OWNER=%q accepted", v)
			continue
		}
		if pw := strings.SplitN(v, ":", 2); len(pw) == 2 && pw[1] != "" && strings.Contains(err.Error(), pw[1]) {
			t.Errorf("the error shows the password: %v", err)
		}
	}
}

func TestParseSize(t *testing.T) {
	for in, want := range map[string]int64{"0": 0, "1024": 1024, "256MiB": 256 << 20, "64MB": 64e6, "1.5GiB": 3 << 29, "10 KiB": 10240} {
		if got, err := ParseSize(in); err != nil || got != want {
			t.Errorf("ParseSize(%q) = %d, %v; want %d", in, got, err, want)
		}
	}
	if _, err := ParseSize("-1MiB"); err == nil {
		t.Error("negative size accepted")
	}
}
