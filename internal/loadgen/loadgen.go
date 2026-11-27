// Package loadgen sends synthetic rrweb recordings to a kimmi server, using
// the same envelopes as the browser SDK, and measures how the server copes.
package loadgen

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
	"slices"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/klauspost/compress/gzip"

	"github.com/dimmihq/kimmi/internal/envelope"
)

// Options are the loadgen flags.
type Options struct {
	Host        string
	Key         string
	Sessions    int
	Concurrency int
	Batches     int
	Interval    time.Duration
	Duration    time.Duration
	// Client is the HTTP client; nil uses a pooled default.
	Client *http.Client
}

// Report is the outcome of a run.
type Report struct {
	Elapsed   time.Duration
	Sessions  int64
	Batches   int64
	Failed    int64
	Bytes     int64
	Errors    map[string]int64
	Latencies []time.Duration
}

type runner struct {
	o      Options
	client *http.Client
	page   page
	url    string

	sessions, batches, failed, bytes atomic.Int64

	mu        sync.Mutex
	errors    map[string]int64
	latencies []time.Duration
}

// Run sends the sessions and returns the report. Progress lines go to progress.
func Run(ctx context.Context, o Options, progress io.Writer) (*Report, error) {
	if o.Sessions < 1 || o.Concurrency < 1 || o.Batches < 1 {
		return nil, errors.New("loadgen: sessions, concurrency and batches must be at least 1")
	}
	if o.Duration > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, o.Duration)
		defer cancel()
	}
	client := o.Client
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second, Transport: &http.Transport{
			MaxIdleConns: o.Concurrency * 2, MaxIdleConnsPerHost: o.Concurrency * 2, IdleConnTimeout: time.Minute}}
	}
	r := &runner{o: o, client: client, page: buildPage(), errors: map[string]int64{},
		url: strings.TrimRight(o.Host, "/") + "/i/v1/batch?key=" + o.Key}

	if err := r.checkKey(ctx); err != nil {
		return nil, err
	}
	fmt.Fprintf(progress, "loadgen: %d sessions × %d batches, %d at a time, %s apart, snapshot %d KB\n",
		o.Sessions, o.Batches, o.Concurrency, o.Interval, len(r.page.snapshot)>>10)

	start := time.Now()
	jobs := make(chan int)
	var wg sync.WaitGroup
	for range o.Concurrency {
		wg.Go(func() {
			for i := range jobs {
				r.session(ctx, i)
			}
		})
	}
	done := make(chan struct{})
	go r.ticker(progress, start, done)
feed:
	for i := range o.Sessions {
		select {
		case jobs <- i:
		case <-ctx.Done():
			break feed
		}
	}
	close(jobs)
	wg.Wait()
	close(done)

	return &Report{Elapsed: time.Since(start), Sessions: r.sessions.Load(), Batches: r.batches.Load(),
		Failed: r.failed.Load(), Bytes: r.bytes.Load(), Errors: r.errors, Latencies: r.latencies}, nil
}

// checkKey fails fast when the key is wrong instead of sending into a wall.
func (r *runner) checkKey(ctx context.Context) error {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(r.o.Host, "/")+"/i/v1/config?key="+r.o.Key, nil)
	res, err := r.client.Do(req)
	if err != nil {
		return fmt.Errorf("loadgen: reach %s: %w", r.o.Host, err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	if res.StatusCode != http.StatusOK || !bytes.Contains(body, []byte(`"recording":true`)) {
		return fmt.Errorf("loadgen: the server does not record for key %s (status %d)", r.o.Key, res.StatusCode)
	}
	return nil
}

func (r *runner) ticker(w io.Writer, start time.Time, done <-chan struct{}) {
	t := time.NewTicker(5 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-done:
			return
		case <-t.C:
			fmt.Fprintf(w, "  %5.0fs  %d sessions  %d batches  %d failed\n",
				time.Since(start).Seconds(), r.sessions.Load(), r.batches.Load(), r.failed.Load())
		}
	}
}

// session plays one visit: batch 0 carries the full snapshot, the rest carry
// activity, with an SPA navigation now and then.
func (r *runner) session(ctx context.Context, n int) {
	rng := rand.New(rand.NewPCG(uint64(n), uint64(time.Now().UnixNano())))
	start := time.Now().UnixMilli()
	g := &eventGen{rng: rng, page: &r.page, ts: start - 1, x: 700, y: 400}
	sid, anon := uuid.Must(uuid.NewV7()).String(), uuid.NewString()
	ua := userAgents[rng.IntN(len(userAgents))]
	meta := envelope.Meta{V: 1, SessionID: sid, WindowID: uuid.NewString(), AnonymousID: anon, StartedAt: start,
		Referrer: "https://www.google.com/", Viewport: envelope.Viewport{W: 1440, H: 900}, Language: "en-GB",
		Timezone: timezones[rng.IntN(len(timezones))], Release: "v4.18.2"}
	if strings.Contains(ua, "iPhone") || strings.Contains(ua, "Android") {
		meta.Viewport = envelope.Viewport{W: 390, H: 844}
	}
	if rng.IntN(3) == 0 {
		meta.Identity = &envelope.Identity{ID: fmt.Sprintf("user-%d", n), Email: fmt.Sprintf("user%d@example.com", n),
			Name: fmt.Sprintf("Shopper %d", n)}
	}
	path := "/"
	for seq := range r.o.Batches {
		if ctx.Err() != nil {
			return
		}
		var l eventList
		var t tally
		g.limit = time.Now().UnixMilli()
		meta.Seq, meta.FirstTs, meta.Paths, meta.Counts = int64(seq), g.ts, nil, envelope.Counts{}
		if seq == 0 {
			g.opening(&l, "https://shop.acme.dev"+path, path, meta.Viewport.W, meta.Viewport.H)
			meta.Counts.Pageviews = 1
			meta.Paths = []string{path}
		} else if rng.IntN(4) == 0 {
			path = paths[rng.IntN(len(paths))]
			g.navigate(&l, "https://shop.acme.dev"+path, path)
			meta.Counts.Pageviews = 1
			meta.Paths = []string{path}
		}
		g.activity(&l, 30+rng.IntN(90), &t)
		meta.LastTs, meta.URL, meta.Path = g.ts, "https://shop.acme.dev"+path, path
		meta.Counts.Events, meta.Counts.Clicks, meta.Counts.Keypresses = l.n, t.clicks, t.keypresses
		meta.Counts.ActiveMs = (meta.LastTs - meta.FirstTs) * 7 / 10
		if rng.IntN(40) == 0 {
			meta.Counts.RageClicks = 1
		}
		if rng.IntN(60) == 0 {
			meta.Counts.Errors = 1
		}
		r.send(ctx, meta, l.json(), ua)
		if seq < r.o.Batches-1 {
			select {
			case <-ctx.Done():
				return
			case <-time.After(r.o.Interval):
			}
		}
	}
	r.sessions.Add(1)
}

func (r *runner) send(ctx context.Context, meta envelope.Meta, events []byte, ua string) {
	var gz bytes.Buffer
	zw := gzip.NewWriter(&gz)
	zw.Write(events)
	zw.Close()
	body, err := envelope.Encode(meta, gz.Bytes())
	if err != nil {
		r.fail("encode")
		return
	}
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, r.url, bytes.NewReader(body))
	req.Header.Set("Content-Type", "text/plain;charset=UTF-8") // what sendBeacon sends
	req.Header.Set("User-Agent", ua)
	begin := time.Now()
	res, err := r.client.Do(req)
	took := time.Since(begin)
	if err != nil {
		if ctx.Err() == nil {
			r.fail("network")
		}
		return
	}
	io.Copy(io.Discard, res.Body)
	res.Body.Close()
	r.mu.Lock()
	r.latencies = append(r.latencies, took)
	r.mu.Unlock()
	if res.StatusCode != http.StatusNoContent {
		r.fail(fmt.Sprintf("status %d", res.StatusCode))
		return
	}
	r.batches.Add(1)
	r.bytes.Add(int64(len(body)))
}

func (r *runner) fail(kind string) {
	r.failed.Add(1)
	r.mu.Lock()
	r.errors[kind]++
	r.mu.Unlock()
}

func percentile(sorted []time.Duration, p float64) time.Duration {
	if len(sorted) == 0 {
		return 0
	}
	return sorted[min(len(sorted)-1, int(float64(len(sorted))*p))]
}

func (rep *Report) String() string {
	secs := max(rep.Elapsed.Seconds(), 0.001)
	lat := slices.Clone(rep.Latencies)
	slices.Sort(lat)
	var b strings.Builder
	fmt.Fprintf(&b, "elapsed   %s\n", rep.Elapsed.Round(time.Millisecond))
	fmt.Fprintf(&b, "sessions  %d (%.1f/s)\n", rep.Sessions, float64(rep.Sessions)/secs)
	fmt.Fprintf(&b, "batches   %d ok (%.1f/s), %d failed\n", rep.Batches, float64(rep.Batches)/secs, rep.Failed)
	fmt.Fprintf(&b, "bytes     %.1f MB (%.2f MB/s)\n", float64(rep.Bytes)/1e6, float64(rep.Bytes)/1e6/secs)
	if len(rep.Errors) == 0 {
		b.WriteString("errors    none\n")
	} else {
		kinds := make([]string, 0, len(rep.Errors))
		for k := range rep.Errors {
			kinds = append(kinds, k)
		}
		sort.Strings(kinds)
		parts := make([]string, len(kinds))
		for i, k := range kinds {
			parts[i] = fmt.Sprintf("%s: %d", k, rep.Errors[k])
		}
		fmt.Fprintf(&b, "errors    %s\n", strings.Join(parts, ", "))
	}
	fmt.Fprintf(&b, "latency   p50 %s  p95 %s  p99 %s\n", percentile(lat, 0.50).Round(10*time.Microsecond),
		percentile(lat, 0.95).Round(10*time.Microsecond), percentile(lat, 0.99).Round(10*time.Microsecond))
	return b.String()
}
