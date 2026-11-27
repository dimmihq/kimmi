// Package useragent reads device class, browser and operating system from a
// User-Agent header. It knows the common browsers and nothing more.
package useragent

import "strings"

// Device classes.
const (
	Desktop = "Desktop"
	Mobile  = "Mobile"
	Tablet  = "Tablet"
)

// Agent is what a User-Agent says about the client.
type Agent struct {
	Device  string
	Browser string
	OS      string
}

// browsers is checked in order: Chromium forks also say "Chrome" and almost
// everything says "Safari", so the specific tokens come first.
var browsers = []struct{ token, name string }{
	{"Edg/", "Edge"}, {"EdgA/", "Edge"}, {"EdgiOS/", "Edge"},
	{"OPR/", "Opera"}, {"Arc/", "Arc"},
	{"SamsungBrowser/", "Samsung Internet"},
	{"Firefox/", "Firefox"}, {"FxiOS/", "Firefox"},
	{"CriOS/", "Chrome"}, {"Chrome/", "Chrome"},
	{"Safari/", "Safari"},
}

var systems = []struct{ token, name string }{
	{"Windows", "Windows"},
	{"iPhone", "iOS"}, {"iPad", "iOS"}, {"iPod", "iOS"},
	{"Android", "Android"},
	{"CrOS", "ChromeOS"},
	{"Macintosh", "macOS"}, {"Mac OS X", "macOS"},
	{"Linux", "Linux"},
}

// Parse reads ua. Unknown parts come back as "Other"; the device defaults to Desktop.
func Parse(ua string) Agent {
	a := Agent{Device: Desktop, Browser: "Other", OS: "Other"}
	for _, b := range browsers {
		if strings.Contains(ua, b.token) {
			a.Browser = b.name
			break
		}
	}
	for _, s := range systems {
		if strings.Contains(ua, s.token) {
			a.OS = s.name
			break
		}
	}
	switch {
	case strings.Contains(ua, "iPad"), strings.Contains(ua, "Tablet"),
		a.OS == "Android" && !strings.Contains(ua, "Mobile"):
		a.Device = Tablet
	case strings.Contains(ua, "Mobi"), strings.Contains(ua, "iPhone"), strings.Contains(ua, "iPod"):
		a.Device = Mobile
	}
	return a
}
