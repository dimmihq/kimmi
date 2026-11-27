// Package config reads kimmi's settings from the environment.
package config

import (
	"errors"
	"fmt"
	"net/netip"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"
)

// Roles a process can run.
const (
	RoleIngest = "ingest"
	RoleAPI    = "api"
	RoleWorker = "worker"
)

// Config is the validated server configuration.
type Config struct {
	HTTPAddr      string
	PublicURL     string
	Secret        string
	DatabaseURL   string
	Storage       string
	StoragePath   string
	S3            S3
	Roles         []string
	Signups       string
	FlushInterval time.Duration
	SessionIdle   time.Duration
	LiveWindow    time.Duration

	// DebugAddr serves net/http/pprof when set; never the public listener.
	DebugAddr string
	// MemoryLimit is the Go runtime's soft memory limit in bytes (0: none).
	// GOMEMLIMIT, when set, wins and MemoryLimit is left at 0.
	MemoryLimit int64
	// IngestBuffer caps the bytes waiting to be flushed on this node;
	// IngestProjectBuffer caps one project's share of it.
	IngestBuffer        int64
	IngestProjectBuffer int64
	// IngestRate and IngestBurst are the per (key, IP) token bucket for
	// batches, in batches per second; a zero rate disables it.
	IngestRate  float64
	IngestBurst int
	// AuthRate and AuthBurst limit sign-in style requests per IP, in
	// attempts per minute; a zero rate disables it.
	AuthRate  float64
	AuthBurst int
	// TrustedProxies are the peers whose X-Forwarded-For is believed.
	TrustedProxies []netip.Prefix

	// Org names the organisation created by KIMMI_OWNER or KIMMI_BOOTSTRAP.
	Org string
	// OwnerEmail and OwnerPassword come from KIMMI_OWNER.
	OwnerEmail, OwnerPassword string
	// Bootstrap is the path of the KIMMI_BOOTSTRAP file.
	Bootstrap string
}

// Secure reports whether the public URL is https, so cookies are Secure
// and HSTS is sent.
func (c Config) Secure() bool { return strings.HasPrefix(c.PublicURL, "https://") }

// S3 holds the settings of the s3 storage driver.
type S3 struct {
	Endpoint, Bucket, Region, AccessKey, SecretKey string
}

// Has reports whether the process runs the given role.
func (c Config) Has(role string) bool { return slices.Contains(c.Roles, role) }

// Load reads the configuration through getenv and validates it. Every problem
// is reported at once so a misconfigured server fails with one clear message.
func Load(getenv func(string) string) (Config, error) {
	get := func(key, fallback string) string {
		if v := strings.TrimSpace(getenv(key)); v != "" {
			return v
		}
		return fallback
	}
	var problems []string
	duration := func(key, fallback string) time.Duration {
		raw := get(key, fallback)
		d, err := time.ParseDuration(raw)
		if err != nil || d < 0 {
			problems = append(problems, fmt.Sprintf("%s: %q is not a duration like 2s or 30m", key, raw))
		}
		return d
	}

	c := Config{
		HTTPAddr:    get("KIMMI_HTTP_ADDR", ":8700"),
		PublicURL:   strings.TrimRight(get("KIMMI_PUBLIC_URL", "http://localhost:8700"), "/"),
		Secret:      getenv("KIMMI_SECRET"),
		DatabaseURL: get("KIMMI_DATABASE_URL", "sqlite://./data/kimmi.db"),
		Storage:     get("KIMMI_STORAGE", "local"),
		StoragePath: get("KIMMI_STORAGE_PATH", "./data/recordings"),
		S3: S3{
			Endpoint:  get("KIMMI_S3_ENDPOINT", ""),
			Bucket:    get("KIMMI_S3_BUCKET", ""),
			Region:    get("KIMMI_S3_REGION", "us-east-1"),
			AccessKey: get("KIMMI_S3_ACCESS_KEY", ""),
			SecretKey: get("KIMMI_S3_SECRET_KEY", ""),
		},
		Signups:       get("KIMMI_SIGNUPS", "open"),
		FlushInterval: duration("KIMMI_FLUSH_INTERVAL", "2s"),
		SessionIdle:   duration("KIMMI_SESSION_IDLE", "30m"),
		LiveWindow:    duration("KIMMI_LIVE_WINDOW", "45s"),
	}

	if len(c.Secret) < 32 {
		problems = append(problems, "KIMMI_SECRET: required, at least 32 characters (try: openssl rand -hex 32)")
	}
	if u, err := url.Parse(c.PublicURL); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		problems = append(problems, fmt.Sprintf("KIMMI_PUBLIC_URL: %q is not an http(s) URL", c.PublicURL))
	}
	if _, _, err := SplitDatabaseURL(c.DatabaseURL); err != nil {
		problems = append(problems, "KIMMI_DATABASE_URL: "+err.Error())
	}
	switch c.Storage {
	case "local":
	case "s3":
		for key, v := range map[string]string{
			"KIMMI_S3_ENDPOINT": c.S3.Endpoint, "KIMMI_S3_BUCKET": c.S3.Bucket,
			"KIMMI_S3_ACCESS_KEY": c.S3.AccessKey, "KIMMI_S3_SECRET_KEY": c.S3.SecretKey,
		} {
			if v == "" {
				problems = append(problems, key+": required when KIMMI_STORAGE=s3")
			}
		}
	default:
		problems = append(problems, fmt.Sprintf("KIMMI_STORAGE: %q must be local or s3", c.Storage))
	}
	if c.Signups != "open" && c.Signups != "closed" {
		problems = append(problems, fmt.Sprintf("KIMMI_SIGNUPS: %q must be open or closed", c.Signups))
	}
	for _, r := range strings.Split(get("KIMMI_ROLES", "all"), ",") {
		switch r = strings.TrimSpace(r); r {
		case "all":
			c.Roles = []string{RoleIngest, RoleAPI, RoleWorker}
		case RoleIngest, RoleAPI, RoleWorker:
			if !c.Has(r) {
				c.Roles = append(c.Roles, r)
			}
		default:
			problems = append(problems, fmt.Sprintf("KIMMI_ROLES: unknown role %q (use ingest, api, worker or all)", r))
		}
	}
	if c.FlushInterval == 0 {
		problems = append(problems, "KIMMI_FLUSH_INTERVAL: must be above zero")
	}

	size := func(key, fallback string) int64 {
		raw := get(key, fallback)
		n, err := ParseSize(raw)
		if err != nil {
			problems = append(problems, fmt.Sprintf("%s: %q is not a size like 256MiB or 64MB", key, raw))
		}
		return n
	}
	number := func(key, fallback string) float64 {
		raw := get(key, fallback)
		n, err := strconv.ParseFloat(raw, 64)
		if err != nil || n < 0 || n != n {
			problems = append(problems, fmt.Sprintf("%s: %q is not a number of zero or more", key, raw))
		}
		return n
	}
	c.DebugAddr = get("KIMMI_DEBUG_ADDR", "")
	if strings.TrimSpace(getenv("GOMEMLIMIT")) == "" {
		c.MemoryLimit = size("KIMMI_MEMORY_LIMIT", "256MiB")
	}
	c.IngestBuffer = size("KIMMI_INGEST_BUFFER", "64MiB")
	if c.IngestBuffer < 1<<20 {
		problems = append(problems, "KIMMI_INGEST_BUFFER: must be at least 1MiB")
	}
	c.IngestProjectBuffer = size("KIMMI_INGEST_PROJECT_BUFFER", strconv.FormatInt(c.IngestBuffer/2, 10))
	if c.IngestProjectBuffer <= 0 || c.IngestProjectBuffer > c.IngestBuffer {
		c.IngestProjectBuffer = c.IngestBuffer
	}
	c.IngestRate = number("KIMMI_INGEST_RATE", "20")
	c.IngestBurst = int(number("KIMMI_INGEST_BURST", "60"))
	c.AuthRate = number("KIMMI_AUTH_RATE", "10")
	c.AuthBurst = int(number("KIMMI_AUTH_BURST", "10"))
	if c.IngestRate > 0 && c.IngestBurst < 1 {
		c.IngestBurst = 1
	}
	if c.AuthRate > 0 && c.AuthBurst < 1 {
		c.AuthBurst = 1
	}
	for _, raw := range strings.Split(get("KIMMI_TRUSTED_PROXIES", ""), ",") {
		if raw = strings.TrimSpace(raw); raw == "" {
			continue
		}
		p, err := netip.ParsePrefix(raw)
		if err != nil {
			a, aerr := netip.ParseAddr(raw)
			if aerr != nil {
				problems = append(problems, fmt.Sprintf("KIMMI_TRUSTED_PROXIES: %q is not a CIDR like 10.0.0.0/8", raw))
				continue
			}
			p = netip.PrefixFrom(a, a.BitLen())
		}
		c.TrustedProxies = append(c.TrustedProxies, p.Masked())
	}

	c.Org = get("KIMMI_ORG", "kimmi")
	if owner := strings.TrimSpace(getenv("KIMMI_OWNER")); owner != "" {
		// The value holds a password: never quote it in a message.
		email, password, ok := strings.Cut(owner, ":")
		email = strings.ToLower(strings.TrimSpace(email))
		switch {
		case !ok || email == "" || !strings.Contains(email, "@") || strings.ContainsAny(email, " \t"):
			problems = append(problems, "KIMMI_OWNER: must be email:password")
		case len(password) < 8 || len(password) > 72:
			problems = append(problems, "KIMMI_OWNER: the password must be 8 to 72 characters")
		default:
			c.OwnerEmail, c.OwnerPassword = email, password
		}
	}
	c.Bootstrap = get("KIMMI_BOOTSTRAP", "")

	if len(problems) > 0 {
		slices.Sort(problems)
		return Config{}, errors.New("invalid configuration:\n  " + strings.Join(problems, "\n  "))
	}
	return c, nil
}

// ParseSize reads a byte size: a plain number of bytes, or a number with
// one of the suffixes B, KB, MB, GB (powers of 1000) or KiB, MiB, GiB
// (powers of 1024). "0" means none.
func ParseSize(raw string) (int64, error) {
	s := strings.TrimSpace(raw)
	units := []struct {
		suffix string
		mult   int64
	}{{"KiB", 1 << 10}, {"MiB", 1 << 20}, {"GiB", 1 << 30}, {"KB", 1e3}, {"MB", 1e6}, {"GB", 1e9}, {"B", 1}}
	mult := int64(1)
	for _, u := range units {
		if strings.HasSuffix(s, u.suffix) {
			s, mult = strings.TrimSpace(strings.TrimSuffix(s, u.suffix)), u.mult
			break
		}
	}
	n, err := strconv.ParseFloat(s, 64)
	if err != nil || n < 0 || n != n || n*float64(mult) > 1<<62 {
		return 0, fmt.Errorf("%q is not a size", raw)
	}
	return int64(n * float64(mult)), nil
}

// SplitDatabaseURL returns the driver ("sqlite" or "postgres") and the
// driver-specific address of a KIMMI_DATABASE_URL.
func SplitDatabaseURL(raw string) (driver, addr string, err error) {
	switch {
	case strings.HasPrefix(raw, "sqlite://"):
		path := strings.TrimPrefix(raw, "sqlite://")
		if path == "" {
			return "", "", errors.New("sqlite:// needs a file path, like sqlite://./data/kimmi.db")
		}
		return "sqlite", path, nil
	case strings.HasPrefix(raw, "postgres://"), strings.HasPrefix(raw, "postgresql://"):
		return "postgres", raw, nil
	}
	return "", "", fmt.Errorf("%q must start with sqlite:// or postgres://", raw)
}
