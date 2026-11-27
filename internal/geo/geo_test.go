package geo

import "testing"

func TestFromTimezone(t *testing.T) {
	cases := map[string]Place{
		"Africa/Lagos":                   {"NG", "Nigeria", "Lagos"},
		"Europe/London":                  {"GB", "United Kingdom", "London"},
		"America/Argentina/Buenos_Aires": {"AR", "Argentina", "Buenos Aires"},
		"America/Boise":                  {"", "", "Boise"},
		"America/Port_of_Spain":          {"", "", "Port of Spain"},
		"UTC":                            {},
		"":                               {},
	}
	for tz, want := range cases {
		if got := FromTimezone(tz); got != want {
			t.Errorf("FromTimezone(%q) = %+v, want %+v", tz, got, want)
		}
	}
}

func TestTableIsComplete(t *testing.T) {
	if len(zones) < 60 {
		t.Fatalf("only %d zones, want at least 60", len(zones))
	}
	for tz, z := range zones {
		if countries[z.code] == "" {
			t.Errorf("%s: country %s has no name", tz, z.code)
		}
	}
}
