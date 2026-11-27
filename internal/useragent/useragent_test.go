package useragent

import "testing"

func TestParse(t *testing.T) {
	cases := []struct {
		ua   string
		want Agent
	}{
		{"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
			Agent{Desktop, "Chrome", "macOS"}},
		{"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.2903.70",
			Agent{Desktop, "Edge", "Windows"}},
		{"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
			Agent{Desktop, "Safari", "macOS"}},
		{"Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0",
			Agent{Desktop, "Firefox", "Linux"}},
		{"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Arc/1.70.0",
			Agent{Desktop, "Arc", "macOS"}},
		{"Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
			Agent{Mobile, "Safari", "iOS"}},
		{"Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1",
			Agent{Mobile, "Chrome", "iOS"}},
		{"Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
			Agent{Tablet, "Safari", "iOS"}},
		{"Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.81 Mobile Safari/537.36",
			Agent{Mobile, "Chrome", "Android"}},
		{"Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
			Agent{Tablet, "Chrome", "Android"}},
		{"Mozilla/5.0 (Android 14; Mobile; rv:133.0) Gecko/133.0 Firefox/133.0",
			Agent{Mobile, "Firefox", "Android"}},
		{"curl/8.7.1", Agent{Desktop, "Other", "Other"}},
	}
	for _, c := range cases {
		if got := Parse(c.ua); got != c.want {
			t.Errorf("Parse(%q)\n got %+v\nwant %+v", c.ua, got, c.want)
		}
	}
}
