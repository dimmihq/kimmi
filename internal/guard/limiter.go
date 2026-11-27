// Package guard holds kimmi's request-level defences: per-client token
// buckets, the client address behind trusted proxies, and the security
// headers of dashboard responses. Everything is in memory and per process.
package guard

import (
	"math"
	"sync"
	"time"
)

// maxBuckets bounds a Limiter's memory (about 100 bytes a bucket).
const maxBuckets = 100_000

// Limiter is a set of token buckets, one per key. A nil Limiter allows
// everything.
type Limiter struct {
	rate  float64 // tokens per second
	burst float64
	now   func() time.Time

	mu        sync.Mutex
	buckets   map[string]*bucket
	lastSweep time.Time
}

type bucket struct {
	tokens float64
	at     time.Time
}

// NewLimiter returns buckets that refill at perSecond and hold burst
// tokens; a rate of zero or less returns nil, which allows everything.
func NewLimiter(perSecond float64, burst int) *Limiter {
	if perSecond <= 0 {
		return nil
	}
	return &Limiter{rate: perSecond, burst: float64(max(burst, 1)), now: time.Now, buckets: map[string]*bucket{}}
}

// Allow takes one token from key's bucket. When there is none it reports
// how long until there is.
func (l *Limiter) Allow(key string) (bool, time.Duration) {
	if l == nil {
		return true, 0
	}
	now := l.now()
	l.mu.Lock()
	defer l.mu.Unlock()
	l.sweep(now)
	b := l.buckets[key]
	if b == nil {
		b = &bucket{tokens: l.burst, at: now}
		l.buckets[key] = b
	} else {
		b.tokens = math.Min(l.burst, b.tokens+now.Sub(b.at).Seconds()*l.rate)
		b.at = now
	}
	if b.tokens >= 1 {
		b.tokens--
		return true, 0
	}
	wait := time.Duration((1 - b.tokens) / l.rate * float64(time.Second))
	return false, wait
}

// sweep drops buckets that have refilled completely (they behave exactly
// like a missing bucket), at most once a minute, and arbitrary ones when
// there are too many keys.
func (l *Limiter) sweep(now time.Time) {
	if len(l.buckets) < maxBuckets && now.Sub(l.lastSweep) < time.Minute {
		return
	}
	l.lastSweep = now
	full := time.Duration(l.burst / l.rate * float64(time.Second))
	for k, b := range l.buckets {
		if now.Sub(b.at) >= full {
			delete(l.buckets, k)
		}
	}
	for k := range l.buckets {
		if len(l.buckets) < maxBuckets*3/4 {
			break
		}
		delete(l.buckets, k)
	}
}

// Len is the number of tracked keys.
func (l *Limiter) Len() int {
	if l == nil {
		return 0
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.buckets)
}

// RetryAfter formats a wait as whole seconds for the Retry-After header.
func RetryAfter(d time.Duration) string {
	s := int64(math.Ceil(d.Seconds()))
	if s < 1 {
		s = 1
	}
	return itoa(s)
}

func itoa(n int64) string {
	var b [20]byte
	i := len(b)
	for {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
		if n == 0 {
			return string(b[i:])
		}
	}
}
