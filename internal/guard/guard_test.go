package guard

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
	"time"
)

func TestLimiter(t *testing.T) {
	now := time.Unix(1000, 0)
	l := NewLimiter(1, 3) // 1 a second, burst 3
	l.now = func() time.Time { return now }
	for i := range 3 {
		if ok, _ := l.Allow("a"); !ok {
			t.Fatalf("attempt %d refused within the burst", i)
		}
	}
	ok, wait := l.Allow("a")
	if ok || wait <= 0 || wait > time.Second {
		t.Fatalf("fourth attempt: ok=%v wait=%v", ok, wait)
	}
	if ok, _ := l.Allow("b"); !ok {
		t.Fatal("another key shares the bucket")
	}
	now = now.Add(1500 * time.Millisecond)
	if ok, _ := l.Allow("a"); !ok {
		t.Fatal("no refill after 1.5 s")
	}
	if ok, _ := l.Allow("a"); ok {
		t.Fatal("refilled more than the rate")
	}
	// Full buckets are forgotten.
	now = now.Add(time.Hour)
	l.Allow("c")
	if n := l.Len(); n != 1 {
		t.Fatalf("%d buckets kept after a sweep, want 1", n)
	}
	if RetryAfter(1200*time.Millisecond) != "2" || RetryAfter(0) != "1" || RetryAfter(61*time.Second) != "61" {
		t.Fatal("Retry-After rounding")
	}
	var none *Limiter = NewLimiter(0, 10)
	if ok, _ := none.Allow("x"); !ok || none != nil {
		t.Fatal("a zero rate must allow everything")
	}
}

func TestLimiterBounded(t *testing.T) {
	l := NewLimiter(1, 1)
	for i := range maxBuckets + 10 {
		l.Allow(fmt.Sprint(i))
	}
	if n := l.Len(); n > maxBuckets {
		t.Fatalf("%d buckets, cap %d", n, maxBuckets)
	}
}

func request(remote string, xff ...string) *http.Request {
	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = remote
	for _, v := range xff {
		r.Header.Add("X-Forwarded-For", v)
	}
	return r
}

func TestClientIP(t *testing.T) {
	none := Proxies{}
	if got := none.String(request("203.0.113.9:5000", "1.2.3.4")); got != "203.0.113.9" {
		t.Fatalf("untrusted peer: got %s, the header must be ignored", got)
	}
	ingress := Proxies{Trusted: []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8"), netip.MustParsePrefix("fd00::/8")}}
	cases := []struct {
		remote string
		xff    []string
		want   string
	}{
		{"10.1.2.3:80", []string{"198.51.100.7"}, "198.51.100.7"},
		{"10.1.2.3:80", []string{"6.6.6.6, 198.51.100.7"}, "198.51.100.7"},           // a spoofed left entry is ignored
		{"10.1.2.3:80", []string{"6.6.6.6, 198.51.100.7, 10.9.9.9"}, "198.51.100.7"}, // trusted hops are skipped
		{"10.1.2.3:80", []string{"6.6.6.6", "198.51.100.7"}, "198.51.100.7"},         // several headers
		{"10.1.2.3:80", nil, "10.1.2.3"},
		{"10.1.2.3:80", []string{"garbage, 198.51.100.7"}, "198.51.100.7"},
		{"10.1.2.3:80", []string{"198.51.100.7, garbage"}, "10.1.2.3"},
		{"203.0.113.9:80", []string{"198.51.100.7"}, "203.0.113.9"}, // peer not trusted
		{"[fd00::1]:80", []string{"2001:db8::5"}, "2001:db8::5"},
		{"[::ffff:10.0.0.1]:80", []string{"198.51.100.7"}, "198.51.100.7"},
	}
	for _, c := range cases {
		if got := ingress.String(request(c.remote, c.xff...)); got != c.want {
			t.Errorf("%s %v: got %s, want %s", c.remote, c.xff, got, c.want)
		}
	}
	if k := none.LimitKey(request("[2001:db8:1:2:3:4:5:6]:80")); k != "2001:db8:1:2::/64" {
		t.Fatalf("IPv6 limit key %s", k)
	}
}

func TestHeaders(t *testing.T) {
	ok := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {})
	rec := httptest.NewRecorder()
	Dashboard(ok, true).ServeHTTP(rec, httptest.NewRequest("GET", "/", nil))
	h := rec.Header()
	for k, want := range map[string]string{"X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
		"Referrer-Policy": "strict-origin-when-cross-origin", "Strict-Transport-Security": "max-age=31536000"} {
		if h.Get(k) != want {
			t.Errorf("%s = %q, want %q", k, h.Get(k), want)
		}
	}
	csp := h.Get("Content-Security-Policy")
	// What the rrweb player needs inside its about:blank iframe.
	for _, want := range []string{"script-src 'self';", "style-src 'self' 'unsafe-inline' https: http: data: blob:",
		"img-src 'self' https: http: data: blob:", "frame-ancestors 'none'", "object-src 'none'"} {
		if !strings.Contains(csp, want) {
			t.Errorf("CSP lacks %q: %s", want, csp)
		}
	}
	if strings.Contains(csp, "unsafe-eval") || strings.Contains(csp, "script-src 'self' 'unsafe-inline'") {
		t.Errorf("CSP lets scripts loose: %s", csp)
	}
	rec = httptest.NewRecorder()
	Dashboard(ok, false).ServeHTTP(rec, httptest.NewRequest("GET", "/", nil))
	if rec.Header().Get("Strict-Transport-Security") != "" {
		t.Fatal("HSTS over plain http")
	}
}
