// Package api serves the dashboard API under /api/v1.
package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/dimmihq/kimmi/internal/auth"
	"github.com/dimmihq/kimmi/internal/blob"
	"github.com/dimmihq/kimmi/internal/config"
	"github.com/dimmihq/kimmi/internal/guard"
	"github.com/dimmihq/kimmi/internal/ingest"
	"github.com/dimmihq/kimmi/internal/notify"
	"github.com/dimmihq/kimmi/internal/replay"
	"github.com/dimmihq/kimmi/internal/store"
	"github.com/dimmihq/kimmi/internal/worker"
)

// API holds the handlers' dependencies.
type API struct {
	Store  store.Store
	Blob   blob.Store
	Source *replay.Source
	Worker *worker.Worker
	Signer auth.Signer
	Config config.Config
	Log    *slog.Logger
	// Projects is told when a project changes so ingest sees it at once.
	Projects interface{ Invalidate(ctx context.Context) }
	// Ingest reports this node's ingest counters; nil without the ingest role.
	Ingest func() IngestHealth
	// AuthLimit counts sign-in style attempts per client address; nil allows all.
	AuthLimit *guard.Limiter
	Proxies   guard.Proxies
	// Notify delivers webhooks: the test and "send now" buttons use it.
	Notify *notify.Notifier

	Version, Commit string
	StartedAt       time.Time

	// background counts work that outlives its request.
	background sync.WaitGroup
}

// IngestHealth is the ingest state shown on the instance page.
type IngestHealth struct {
	ingest.Snapshot
	BufferedBytes int64
}

// Handler returns the API routes wrapped in request logging.
func (a *API) Handler() http.Handler {
	mux := http.NewServeMux()
	a.routes(mux)
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		a.fail(w, r, &apiError{status: http.StatusNotFound, code: "not_found", msg: "No such API route"})
	})
	return a.logRequests(mux)
}

func (a *API) routes(m *http.ServeMux) {
	const v = "/api/v1"
	m.HandleFunc("GET "+v+"/auth/status", a.authStatus)
	m.HandleFunc("POST "+v+"/auth/signup", a.limited(a.signup))
	m.HandleFunc("POST "+v+"/auth/login", a.limited(a.login))
	m.HandleFunc("POST "+v+"/auth/logout", a.logout)
	m.HandleFunc("GET "+v+"/auth/me", a.user(store.RoleViewer, a.me))
	m.HandleFunc("PATCH "+v+"/me", a.user(store.RoleViewer, a.updateMe))
	m.HandleFunc("POST "+v+"/me/password", a.limited(a.user(store.RoleViewer, a.changePassword)))
	m.HandleFunc("GET "+v+"/me/sessions", a.user(store.RoleViewer, a.listMySessions))
	m.HandleFunc("DELETE "+v+"/me/sessions/{id}", a.user(store.RoleViewer, a.deleteMySession))
	m.HandleFunc("GET "+v+"/me/preferences", a.user(store.RoleViewer, a.getPreferences))
	m.HandleFunc("PUT "+v+"/me/preferences", a.user(store.RoleViewer, a.putPreferences))

	m.HandleFunc("GET "+v+"/members", a.user(store.RoleViewer, a.listMembers))
	m.HandleFunc("PATCH "+v+"/members/{id}", a.user(store.RoleAdmin, a.updateMember))
	m.HandleFunc("DELETE "+v+"/members/{id}", a.user(store.RoleAdmin, a.deleteMember))
	m.HandleFunc("GET "+v+"/invitations", a.user(store.RoleAdmin, a.listInvitations))
	m.HandleFunc("POST "+v+"/invitations", a.user(store.RoleAdmin, a.createInvitation))
	m.HandleFunc("DELETE "+v+"/invitations/{id}", a.user(store.RoleAdmin, a.deleteInvitation))
	m.HandleFunc("GET "+v+"/invitations/lookup/{token}", a.lookupInvitation)
	m.HandleFunc("POST "+v+"/invitations/accept", a.limited(a.acceptInvitation))
	m.HandleFunc("GET "+v+"/tokens", a.user(store.RoleViewer, a.listTokens))
	m.HandleFunc("POST "+v+"/tokens", a.user(store.RoleViewer, a.createToken))
	m.HandleFunc("DELETE "+v+"/tokens/{id}", a.user(store.RoleViewer, a.deleteToken))

	m.HandleFunc("GET "+v+"/projects", a.user(store.RoleViewer, a.listProjects))
	m.HandleFunc("POST "+v+"/projects", a.user(store.RoleAdmin, a.createProject))
	p := v + "/projects/{id}"
	m.HandleFunc("GET "+p, a.project(store.RoleViewer, a.getProject))
	m.HandleFunc("PATCH "+p, a.project(store.RoleAdmin, a.updateProject))
	m.HandleFunc("DELETE "+p, a.project(store.RoleOwner, a.deleteProject))
	m.HandleFunc("POST "+p+"/rotate-key", a.project(store.RoleAdmin, a.rotateKey))
	m.HandleFunc("PUT "+p+"/origins", a.project(store.RoleAdmin, a.putOrigins))
	m.HandleFunc("GET "+p+"/settings", a.project(store.RoleViewer, a.getSettings))
	m.HandleFunc("PATCH "+p+"/settings", a.project(store.RoleAdmin, a.patchSettings))
	m.HandleFunc("GET "+p+"/members", a.project(store.RoleViewer, a.listProjectMembers))
	m.HandleFunc("POST "+p+"/members", a.project(store.RoleAdmin, a.addProjectMember))
	m.HandleFunc("PATCH "+p+"/members/{userId}", a.project(store.RoleAdmin, a.updateProjectMember))
	m.HandleFunc("DELETE "+p+"/members/{userId}", a.project(store.RoleAdmin, a.deleteProjectMember))
	m.HandleFunc("POST "+p+"/delete-recordings", a.project(store.RoleAdmin, a.deleteRecordings))

	m.HandleFunc("GET "+p+"/overview", a.project(store.RoleViewer, a.overview))
	m.HandleFunc("GET "+p+"/recordings", a.project(store.RoleViewer, a.listRecordings))
	m.HandleFunc("GET "+p+"/recordings/{rid}", a.project(store.RoleViewer, a.getRecording))
	m.HandleFunc("GET "+p+"/recordings/{rid}/events", a.project(store.RoleViewer, a.recordingEvents))
	m.HandleFunc("PATCH "+p+"/recordings/{rid}", a.project(store.RoleViewer, a.patchRecording))
	m.HandleFunc("DELETE "+p+"/recordings/{rid}", a.project(store.RoleMember, a.deleteRecording))
	m.HandleFunc("GET "+p+"/live", a.project(store.RoleViewer, a.live))

	m.HandleFunc("GET "+p+"/visitors", a.project(store.RoleViewer, a.listVisitors))
	m.HandleFunc("GET "+p+"/visitors/{vid}", a.project(store.RoleViewer, a.getVisitor))
	m.HandleFunc("DELETE "+p+"/visitors/{vid}", a.project(store.RoleMember, a.deleteVisitor))
	m.HandleFunc("POST "+p+"/visitors/erase", a.project(store.RoleMember, a.eraseVisitors))

	a.analyticsRoutes(m, p)
	a.mcpRoutes(m)

	m.HandleFunc("GET "+v+"/storage", a.user(store.RoleViewer, a.storage))
	m.HandleFunc("POST "+v+"/storage/cleanup", a.user(store.RoleAdmin, a.cleanup))
	m.HandleFunc("GET "+v+"/instance", a.user(store.RoleViewer, a.instance))
}

// limited applies the per-address limit on sign-in style attempts.
func (a *API) limited(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if ok, wait := a.AuthLimit.Allow(a.Proxies.LimitKey(r)); !ok {
			w.Header().Set("Retry-After", guard.RetryAfter(wait))
			a.fail(w, r, &apiError{status: http.StatusTooManyRequests, code: "rate_limited",
				msg: "Too many attempts; wait a minute and try again"})
			return
		}
		h(w, r)
	}
}

// apiError is an error with an HTTP status and the contract's error body.
type apiError struct {
	status int
	code   string
	msg    string
	fields map[string]string
}

func (e *apiError) Error() string { return e.msg }

func invalid(msg string, fields map[string]string) error {
	return &apiError{status: http.StatusBadRequest, code: "invalid", msg: msg, fields: fields}
}

func forbidden(msg string) error {
	return &apiError{status: http.StatusForbidden, code: "forbidden", msg: msg}
}

var (
	errUnauthorized = &apiError{status: http.StatusUnauthorized, code: "unauthorized", msg: "Sign in to continue"}
	errNotFound     = &apiError{status: http.StatusNotFound, code: "not_found", msg: "Not found"}
)

func (a *API) fail(w http.ResponseWriter, r *http.Request, err error) {
	var e *apiError
	switch {
	case errors.As(err, &e):
	case errors.Is(err, store.ErrNotFound):
		e = errNotFound
	case errors.Is(err, store.ErrConflict):
		e = &apiError{status: http.StatusConflict, code: "conflict", msg: "That already exists"}
	case errors.Is(err, context.Canceled):
		return
	default:
		a.Log.Error("api request failed", "method", r.Method, "path", r.URL.Path, "err", err)
		e = &apiError{status: http.StatusInternalServerError, code: "internal", msg: "Something went wrong on the server"}
	}
	body := map[string]any{"code": e.code, "message": e.msg}
	if len(e.fields) > 0 {
		body["fields"] = e.fields
	}
	writeJSON(w, e.status, map[string]any{"error": body})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// decode reads a JSON body into v.
func decode(r *http.Request, v any) error {
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		return fmt.Errorf("read body: %w", err)
	}
	if err := json.Unmarshal(body, v); err != nil {
		return invalid("The request body is not valid JSON for this route", nil)
	}
	return nil
}

func noContent(w http.ResponseWriter) { w.WriteHeader(http.StatusNoContent) }

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusRecorder) Unwrap() http.ResponseWriter { return s.ResponseWriter }

func (a *API) logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		a.Log.Info("api", "method", r.Method, "path", r.URL.Path, "status", rec.status,
			"ms", float64(time.Since(start).Microseconds())/1000)
	})
}
