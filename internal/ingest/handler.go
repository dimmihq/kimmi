// Package ingest receives recordings from the browser SDK: /i/v1/config and
// /i/v1/batch. Requests are answered from memory and batches are buffered,
// so the database sees one transaction per flush, not one per request.
package ingest

import (
	"bytes"
	"errors"
	"io"
	"math/bits"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/dimmihq/kimmi/internal/envelope"
	"github.com/dimmihq/kimmi/internal/geo"
	"github.com/dimmihq/kimmi/internal/guard"
	"github.com/dimmihq/kimmi/internal/store"
	"github.com/dimmihq/kimmi/internal/useragent"
)

// MaxBatchBytes is the largest batch body accepted.
const MaxBatchBytes = 5 << 20

// bodyTimeout bounds how long one batch body may take to arrive, so slow
// senders cannot hold read buffers for long.
const bodyTimeout = 30 * time.Second

// Handler serves the ingest routes.
type Handler struct {
	Cache   *Cache
	Flusher *Flusher
	Stats   *Stats
	// Limit is the per (project, client address) token bucket; nil allows all.
	Limit   *guard.Limiter
	Proxies guard.Proxies
	// MaxReading caps the body bytes being read at once across requests;
	// past it a batch is answered 503 before its body is read. 0: no cap.
	MaxReading int64

	reading atomic.Int64
}

// Register adds the ingest routes to mux.
func (h *Handler) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /i/v1/config", h.config)
	mux.HandleFunc("POST /i/v1/batch", h.batch)
	mux.HandleFunc("OPTIONS /i/v1/", h.preflight)
}

func cors(w http.ResponseWriter) {
	hd := w.Header()
	hd.Set("Access-Control-Allow-Origin", "*")
	hd.Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	hd.Set("Access-Control-Allow-Headers", "Content-Type")
	hd.Set("Access-Control-Max-Age", "86400")
}

func (h *Handler) preflight(w http.ResponseWriter, _ *http.Request) {
	cors(w)
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) reject(w http.ResponseWriter, status int) {
	h.Stats.Rejected.Add(1)
	w.WriteHeader(status)
}

// config answers unknown keys with recording off, so the SDK stays quiet.
func (h *Handler) config(w http.ResponseWriter, r *http.Request) {
	h.Stats.request(time.Now())
	cors(w)
	p, ok := h.Cache.Lookup(r.URL.Query().Get("key"))
	if ok && !p.Allows(r.Header.Get("Origin")) {
		h.reject(w, http.StatusForbidden)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-cache")
	if !ok {
		w.Write(disabledConfig)
		return
	}
	w.Write(p.Config)
}

func (h *Handler) batch(w http.ResponseWriter, r *http.Request) {
	now := time.Now()
	h.Stats.request(now)
	cors(w)
	p, ok := h.Cache.Lookup(r.URL.Query().Get("key"))
	if !ok || !p.Allows(r.Header.Get("Origin")) {
		h.reject(w, http.StatusForbidden)
		return
	}
	if r.ContentLength > MaxBatchBytes {
		h.reject(w, http.StatusRequestEntityTooLarge)
		return
	}
	if ok, wait := h.Limit.Allow(p.ID + " " + h.Proxies.LimitKey(r)); !ok {
		w.Header().Set("Retry-After", guard.RetryAfter(wait))
		h.reject(w, http.StatusTooManyRequests)
		return
	}
	// Reserve the body's size before reading it: the declared length, or
	// the largest batch when the sender did not declare one.
	reserve := r.ContentLength
	if reserve < 0 {
		reserve = MaxBatchBytes
	}
	if !h.reserve(reserve) {
		w.Header().Set("Retry-After", "2")
		h.reject(w, http.StatusServiceUnavailable)
		return
	}
	defer h.reading.Add(-reserve)
	_ = http.NewResponseController(w).SetReadDeadline(now.Add(bodyTimeout))
	buf, err := readBody(http.MaxBytesReader(w, r.Body, MaxBatchBytes), r.ContentLength)
	var tooBig *http.MaxBytesError
	if errors.As(err, &tooBig) {
		h.reject(w, http.StatusRequestEntityTooLarge)
		return
	}
	if err != nil {
		h.reject(w, http.StatusBadRequest)
		return
	}
	defer buffers.put(buf)
	body := *buf
	meta, payload, err := envelope.Parse(body)
	if err != nil {
		h.reject(w, http.StatusBadRequest)
		return
	}
	if err := h.Flusher.Add(block(p, meta, r.UserAgent(), now), payload); err != nil {
		w.Header().Set("Retry-After", "2")
		h.reject(w, http.StatusServiceUnavailable)
		return
	}
	h.Stats.Accepted.Add(1)
	h.Stats.Bytes.Add(int64(len(body)))
	w.WriteHeader(http.StatusNoContent)
}

// reserve claims n bytes of the read budget.
func (h *Handler) reserve(n int64) bool {
	if h.MaxReading <= 0 {
		h.reading.Add(n)
		return true
	}
	for {
		cur := h.reading.Load()
		if cur+n > h.MaxReading && cur > 0 {
			return false
		}
		if h.reading.CompareAndSwap(cur, cur+n) {
			return true
		}
	}
}

// bufferPool hands out byte slices in power-of-two size classes, so batch
// bodies are read into reused memory instead of freshly grown slices.
type bufferPool struct {
	classes [24]sync.Pool // 1 B .. 8 MiB
}

var buffers bufferPool

func (bp *bufferPool) get(n int) *[]byte {
	c := bits.Len(uint(max(n, 1) - 1))
	if c >= len(bp.classes) {
		b := make([]byte, n)
		return &b
	}
	if v, ok := bp.classes[c].Get().(*[]byte); ok {
		*v = (*v)[:n]
		return v
	}
	b := make([]byte, n, 1<<c)
	return &b
}

func (bp *bufferPool) put(b *[]byte) {
	c := bits.Len(uint(cap(*b)) - 1)
	if cap(*b) != 1<<c || c >= len(bp.classes) {
		return
	}
	bp.classes[c].Put(b)
}

// readBody reads a body of declared length n (or unknown, n < 0) into a
// pooled buffer.
func readBody(r io.Reader, n int64) (*[]byte, error) {
	if n >= 0 {
		buf := buffers.get(int(n))
		if _, err := io.ReadFull(r, *buf); err != nil {
			buffers.put(buf)
			return nil, err
		}
		return buf, nil
	}
	buf := buffers.get(64 << 10)
	*buf = (*buf)[:0]
	for {
		if len(*buf) == cap(*buf) {
			bigger := buffers.get(2 * cap(*buf))
			*bigger = append((*bigger)[:0], *buf...)
			buffers.put(buf)
			buf = bigger
		}
		m, err := r.Read((*buf)[len(*buf):cap(*buf)])
		*buf = (*buf)[:len(*buf)+m]
		if err == io.EOF {
			return buf, nil
		}
		if err != nil {
			buffers.put(buf)
			return nil, err
		}
	}
}

func block(p *Project, m envelope.Meta, ua string, now time.Time) store.IngestBlock {
	agent := useragent.Parse(ua)
	place := geo.FromTimezone(m.Timezone)
	b := store.IngestBlock{
		Block: store.Block{SessionID: m.SessionID, Seq: m.Seq, ProjectID: p.ID,
			FirstTs: m.FirstTs, LastTs: m.LastTs, CreatedAt: now.UnixMilli()},
		OrgID: p.OrgID, AnonymousID: m.AnonymousID, StartedAt: m.StartedAt,
		Path: m.Path, Paths: m.Paths, Referrer: m.Referrer, Release: m.Release,
		ViewportW: m.Viewport.W, ViewportH: m.Viewport.H,
		Device: agent.Device, Browser: agent.Browser, OS: agent.OS,
		Country: place.Country, CountryCode: place.CountryCode, City: place.City,
		Clicks: m.Counts.Clicks, Keypresses: m.Counts.Keypresses, RageClicks: m.Counts.RageClicks,
		DeadClicks: m.Counts.DeadClicks, Errors: m.Counts.Errors, Pageviews: m.Counts.Pageviews, ActiveMs: m.Counts.ActiveMs,
	}
	if id := m.Identity; id != nil {
		b.ExternalID, b.Email, b.Name = id.ID, id.Email, id.Name
		if t := bytes.TrimSpace(id.Traits); len(t) > 2 && t[0] == '{' {
			b.Traits = t
		}
	}
	return b
}
