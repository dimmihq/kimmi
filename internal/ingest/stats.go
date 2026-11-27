package ingest

import (
	"sync"
	"sync/atomic"
	"time"
)

// Stats counts ingest traffic; it stands in for request logs, which this
// path is too hot for.
type Stats struct {
	Requests atomic.Int64
	Accepted atomic.Int64
	Rejected atomic.Int64
	Bytes    atomic.Int64

	rate meter

	mu           sync.Mutex
	lastFlush    time.Time
	lastFlushErr error
}

// Snapshot is a moment's view of Stats.
type Snapshot struct {
	Requests, Accepted, Rejected, Bytes int64
	RequestsPerSec                      float64
	LastFlush                           time.Time
	LastFlushErr                        error
}

func (s *Stats) request(now time.Time) {
	s.Requests.Add(1)
	s.rate.add(now)
}

func (s *Stats) flushed(now time.Time, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lastFlushErr = err
	if err == nil {
		s.lastFlush = now
	}
}

// Snapshot reads the counters.
func (s *Stats) Snapshot(now time.Time) Snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	return Snapshot{
		Requests: s.Requests.Load(), Accepted: s.Accepted.Load(), Rejected: s.Rejected.Load(), Bytes: s.Bytes.Load(),
		RequestsPerSec: s.rate.perSecond(now), LastFlush: s.lastFlush, LastFlushErr: s.lastFlushErr,
	}
}

// meter counts events per second over the last ten whole seconds.
type meter struct {
	mu     sync.Mutex
	second [10]int64
	count  [10]int64
}

const meterWindow = 10

func (m *meter) add(now time.Time) {
	sec := now.Unix()
	i := sec % meterWindow
	m.mu.Lock()
	if m.second[i] != sec {
		m.second[i], m.count[i] = sec, 0
	}
	m.count[i]++
	m.mu.Unlock()
}

func (m *meter) perSecond(now time.Time) float64 {
	sec := now.Unix()
	m.mu.Lock()
	defer m.mu.Unlock()
	var total int64
	for i := range meterWindow {
		if s := m.second[i]; s < sec && s >= sec-meterWindow {
			total += m.count[i]
		}
	}
	return float64(total) / meterWindow
}
