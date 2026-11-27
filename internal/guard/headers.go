package guard

import "net/http"

// ContentSecurityPolicy is sent with every dashboard response. The
// dashboard itself loads only its own files. The session player is an
// rrweb Replayer: it rebuilds recorded pages inside a sandboxed about:blank
// iframe, which inherits this policy, and injects their CSS as <style>
// elements and style attributes, with images, fonts and stylesheets that
// point back at the recorded site or are data: and blob: URLs. Recorded
// scripts never run (rrweb does not rebuild them and the sandbox forbids
// them), so script-src stays 'self'.
const ContentSecurityPolicy = "default-src 'self'; " +
	"script-src 'self'; " +
	"style-src 'self' 'unsafe-inline' https: http: data: blob:; " +
	"img-src 'self' https: http: data: blob:; " +
	"font-src 'self' https: http: data:; " +
	"media-src 'self' https: http: data: blob:; " +
	"connect-src 'self'; " +
	"frame-src 'self' blob: data:; " +
	"worker-src 'self' blob:; " +
	"object-src 'none'; " +
	"frame-ancestors 'none'; " +
	"form-action 'self'"

// Dashboard sets the security headers of dashboard and API responses. With
// secure (an https public URL) it adds Strict-Transport-Security.
func Dashboard(next http.Handler, secure bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Content-Security-Policy", ContentSecurityPolicy)
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		if secure {
			h.Set("Strict-Transport-Security", "max-age=31536000")
		}
		next.ServeHTTP(w, r)
	})
}

// Transport sets the headers every response gets: no sniffing, and HSTS
// when the public URL is https.
func Transport(next http.Handler, secure bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if secure {
			w.Header().Set("Strict-Transport-Security", "max-age=31536000")
		}
		next.ServeHTTP(w, r)
	})
}
