package ingest

import (
	"testing"
	"time"
)

func TestAllows(t *testing.T) {
	open := &Project{}
	if !open.Allows("https://anything.dev") || !open.Allows("") {
		t.Fatal("an empty list must allow everyone")
	}
	p := &Project{Origins: normalizeOrigins([]string{"https://Shop.Acme.dev/", "https://*.acme.io", " "})}
	cases := map[string]bool{
		"https://shop.acme.dev": true, "https://SHOP.acme.dev": true, "http://shop.acme.dev": false,
		"https://a.acme.io": true, "https://a.b.acme.io": true, "https://acme.io": false, "http://a.acme.io": false,
		"https://evilacme.io": false, "": false,
	}
	for origin, want := range cases {
		if p.Allows(origin) != want {
			t.Errorf("Allows(%q) = %v, want %v", origin, !want, want)
		}
	}
}

func TestMeter(t *testing.T) {
	var m meter
	base := time.Unix(1_000_000, 0)
	for i := range 30 {
		m.add(base.Add(time.Duration(i%3) * time.Second)) // 10 per second for 3 seconds
	}
	if got := m.perSecond(base.Add(3 * time.Second)); got != 3 {
		t.Fatalf("rate %v, want 3 (30 over a 10 s window)", got)
	}
	if got := m.perSecond(base.Add(30 * time.Second)); got != 0 {
		t.Fatalf("stale rate %v", got)
	}
}
