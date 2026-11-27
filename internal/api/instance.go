package api

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/dimmihq/kimmi/internal/config"
)

func (a *API) storage(w http.ResponseWriter, r *http.Request, p *principal) {
	projects, err := a.visibleProjects(r, p)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	ids := make([]string, len(projects))
	for i, pr := range projects {
		ids[i] = pr.ID
	}
	rep, err := a.Store.StorageReport(r.Context(), ids, time.Now().UnixMilli())
	if err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, rep)
}

// cleanup runs retention now. It covers the whole instance: retention is
// per project, and shared objects only go once nothing points to them.
func (a *API) cleanup(w http.ResponseWriter, r *http.Request, _ *principal) {
	res, err := a.Worker.Cleanup(r.Context())
	if err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

type health struct {
	Name   string `json:"name"`
	Status string `json:"status"`
	Detail string `json:"detail"`
}

func ago(t time.Time) string {
	d := time.Since(t).Round(time.Second)
	if d < time.Second {
		return "just now"
	}
	return d.String() + " ago"
}

func (a *API) health(ctx context.Context) []health {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	var out []health

	start := time.Now()
	if err := a.Store.Ping(ctx); err != nil {
		out = append(out, health{"database", "down", err.Error()})
	} else {
		out = append(out, health{"database", "healthy", fmt.Sprintf("Answered in %.1f ms", float64(time.Since(start).Microseconds())/1000)})
	}

	start = time.Now()
	status, detail := "healthy", ""
	for _, err := range a.Blob.List(ctx, "health/") {
		if err != nil {
			status, detail = "down", err.Error()
		}
		break
	}
	if status == "healthy" {
		detail = fmt.Sprintf("Listed in %.1f ms", float64(time.Since(start).Microseconds())/1000)
	}
	out = append(out, health{"storage", status, detail})

	if a.Ingest != nil {
		s := a.Ingest()
		h := health{"ingest", "healthy", fmt.Sprintf("%.0f req/s · %d batches accepted · %d rejected · %d KB buffered",
			s.RequestsPerSec, s.Accepted, s.Rejected, s.BufferedBytes>>10)}
		if s.LastFlushErr != nil {
			h.Status, h.Detail = "degraded", "Last flush failed: "+s.LastFlushErr.Error()
		} else if !s.LastFlush.IsZero() {
			h.Detail += " · last flush " + ago(s.LastFlush)
		}
		out = append(out, h)
	}
	if a.Config.Has(config.RoleWorker) {
		h := health{"worker", "healthy", "Waiting for its first run"}
		if at, err := a.Worker.LastSeal(); err != nil {
			h.Status, h.Detail = "degraded", "Last seal failed: "+err.Error()
		} else if !at.IsZero() {
			h.Detail = "Last seal " + ago(at)
		}
		out = append(out, h)
	}
	return out
}

func (a *API) instance(w http.ResponseWriter, r *http.Request, _ *principal) {
	version, err := a.Store.Version(r.Context())
	if err != nil {
		version = "unknown"
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"version": a.Version, "commit": a.Commit, "startedAt": a.StartedAt.UnixMilli(), "roles": a.Config.Roles,
		"database":  map[string]string{"driver": a.Store.Driver(), "version": version},
		"storage":   map[string]string{"driver": a.Blob.Driver(), "location": a.Blob.Location()},
		"publicUrl": a.Config.PublicURL, "health": a.health(r.Context()),
	})
}
