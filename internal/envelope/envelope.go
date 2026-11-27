// Package envelope reads and writes the ingest batch format: a 4-byte
// big-endian length, that many bytes of JSON metadata, then the gzip of a JSON
// array of rrweb events. The events are never decompressed here.
package envelope

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
)

// MaxMetaBytes bounds the metadata part of a batch.
const MaxMetaBytes = 64 << 10

// Meta is the uncompressed metadata at the head of every batch.
type Meta struct {
	V           int       `json:"v"`
	SessionID   string    `json:"sessionId"`
	WindowID    string    `json:"windowId"`
	Seq         int64     `json:"seq"`
	AnonymousID string    `json:"anonymousId"`
	Identity    *Identity `json:"identity,omitempty"`
	StartedAt   int64     `json:"startedAt"`
	FirstTs     int64     `json:"firstTs"`
	LastTs      int64     `json:"lastTs"`
	URL         string    `json:"url"`
	Path        string    `json:"path"`
	Referrer    string    `json:"referrer"`
	Viewport    Viewport  `json:"viewport"`
	Language    string    `json:"language"`
	Timezone    string    `json:"timezone"`
	Release     string    `json:"release"`
	Counts      Counts    `json:"counts"`
	Paths       []string  `json:"paths"`
}

// Identity is what kimmi.identify() attached to the session.
type Identity struct {
	ID     string          `json:"id"`
	Email  string          `json:"email"`
	Name   string          `json:"name"`
	Traits json.RawMessage `json:"traits,omitempty"`
}

// Viewport is the window size in CSS pixels.
type Viewport struct {
	W int `json:"w"`
	H int `json:"h"`
}

// Counts are the activity totals of this batch alone, not of the session.
type Counts struct {
	Events     int   `json:"events"`
	Clicks     int   `json:"clicks"`
	Keypresses int   `json:"keypresses"`
	RageClicks int   `json:"rageClicks"`
	DeadClicks int   `json:"deadClicks"`
	Errors     int   `json:"errors"`
	Pageviews  int   `json:"pageviews"`
	ActiveMs   int64 `json:"activeMs"`
}

// ErrMalformed wraps every reason a batch is rejected with 400.
var ErrMalformed = errors.New("malformed batch")

// Parse splits a batch body into its metadata and the untouched gzip payload.
func Parse(body []byte) (Meta, []byte, error) {
	var m Meta
	if len(body) < 4 {
		return m, nil, fmt.Errorf("%w: shorter than the length prefix", ErrMalformed)
	}
	n := binary.BigEndian.Uint32(body)
	if n == 0 || n > MaxMetaBytes || int64(n) > int64(len(body)-4) {
		return m, nil, fmt.Errorf("%w: metadata length %d does not fit", ErrMalformed, n)
	}
	if err := json.Unmarshal(body[4:4+n], &m); err != nil {
		return m, nil, fmt.Errorf("%w: metadata: %v", ErrMalformed, err)
	}
	payload := body[4+n:]
	if len(payload) < 18 || payload[0] != 0x1f || payload[1] != 0x8b {
		return m, nil, fmt.Errorf("%w: events are not gzip", ErrMalformed)
	}
	if err := m.validate(); err != nil {
		return m, nil, fmt.Errorf("%w: %v", ErrMalformed, err)
	}
	return m, payload, nil
}

func (m *Meta) validate() error {
	switch {
	case m.V != 1:
		return fmt.Errorf("unsupported version %d", m.V)
	case m.SessionID == "" || len(m.SessionID) > 64:
		return errors.New("sessionId is required")
	case m.AnonymousID == "" || len(m.AnonymousID) > 128:
		return errors.New("anonymousId is required")
	case m.Seq < 0:
		return errors.New("seq must not be negative")
	case m.StartedAt <= 0 || m.FirstTs <= 0 || m.LastTs < m.FirstTs:
		return errors.New("startedAt, firstTs and lastTs must be set and ordered")
	}
	if m.Path == "" {
		m.Path = "/"
	}
	return nil
}

// Encode builds a batch body the way the browser SDK does.
func Encode(m Meta, gzipEvents []byte) ([]byte, error) {
	meta, err := json.Marshal(m)
	if err != nil {
		return nil, fmt.Errorf("encode metadata: %w", err)
	}
	var b bytes.Buffer
	b.Grow(4 + len(meta) + len(gzipEvents))
	_ = binary.Write(&b, binary.BigEndian, uint32(len(meta)))
	b.Write(meta)
	b.Write(gzipEvents)
	return b.Bytes(), nil
}
