// Package webui serves the embedded dashboard as a single-page app, and the
// browser SDK bundle at /kimmi.js.
package webui

import (
	"bytes"
	"embed"
	"io/fs"
	"net/http"
	"path"
	"strings"
	"time"
)

//go:embed dist
var dist embed.FS

// Handler serves the files in dist. Unknown paths get index.html so the
// dashboard's router can take them.
func Handler() http.Handler {
	files, _ := fs.Sub(dist, "dist")
	index, _ := fs.ReadFile(files, "index.html")
	started := time.Now()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		name := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if name != "" && name != "index.html" {
			if data, err := fs.ReadFile(files, name); err == nil {
				w.Header().Set("Cache-Control", cacheControl(name))
				http.ServeContent(w, r, name, started, bytes.NewReader(data))
				return
			}
			if path.Ext(name) != "" && strings.HasPrefix(name, "assets/") {
				http.NotFound(w, r)
				return
			}
		}
		w.Header().Set("Cache-Control", "no-cache")
		http.ServeContent(w, r, "index.html", started, bytes.NewReader(index))
	})
}

func cacheControl(name string) string {
	switch {
	case name == "kimmi.js":
		return "public, max-age=300"
	case strings.HasPrefix(name, "assets/"):
		// Vite puts content hashes in these names, so they never change.
		return "public, max-age=31536000, immutable"
	default:
		return "public, max-age=3600"
	}
}
