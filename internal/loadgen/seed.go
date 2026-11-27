package loadgen

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/klauspost/compress/gzip"

	"github.com/dimmihq/kimmi/internal/envelope"
)

// SeedOptions are the flags of `kimmi seed`: it fills a running server with
// a believable history of the example shop through the ingest endpoints.
// The server must run with KIMMI_TEST_HOOKS=1, so a hit may say when it
// happened, and KIMMI_INGEST_RATE=0.
type SeedOptions struct {
	Host        string
	Key         string
	Days        int
	Visits      int
	Recorded    int // visits that also get a recording
	Concurrency int
	Seed        uint64
	// Analytics false sends the recordings only, for a replay-only project.
	Analytics bool
	// Client is the HTTP client; nil uses a pooled default.
	Client *http.Client
	// Now is when the history ends; zero is the moment Seed starts.
	Now time.Time
}

// SeedReport is the outcome of a run. It counts what the server accepted.
type SeedReport struct {
	Elapsed    time.Duration
	Visits     int64
	PageViews  int64
	Events     int64
	Hits       int64
	Recordings int64
	Batches    int64
	Feedback   int64
	Bytes      int64
	Retries    int64
	Failed     int64
	Errors     map[string]int64
}

// errAnalyticsOff is the first hit answered 403.
var errAnalyticsOff = errors.New("seed: the server refused the first hit (403): analytics is off for this project, or the key is unknown. " +
	"Turn analytics on in the project's settings, or pass --analytics=false to send recordings only")

// seedRetries is how often a request answered 503 or 429 is sent again.
const seedRetries = 5

type seeder struct {
	o      SeedOptions
	client *http.Client
	page   page
	base   string
	now    int64

	visits, pageViews, events, hits, recordings, batches, feedback, bytes, retries, failed atomic.Int64

	mu     sync.Mutex
	errors map[string]int64
}

// Seed generates the history visit by visit and sends it with a pool of
// workers. Progress lines go to progress.
func Seed(ctx context.Context, o SeedOptions, progress io.Writer) (*SeedReport, error) {
	if o.Days < 1 || o.Visits < 1 || o.Concurrency < 1 || o.Recorded < 0 {
		return nil, errors.New("seed: days, visits and concurrency must be at least 1")
	}
	client := o.Client
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second, Transport: &http.Transport{
			MaxIdleConns: o.Concurrency * 2, MaxIdleConnsPerHost: o.Concurrency * 2, IdleConnTimeout: time.Minute}}
	}
	if o.Now.IsZero() {
		o.Now = time.Now()
	}
	s := &seeder{o: o, client: client, page: buildPage(), errors: map[string]int64{},
		base: strings.TrimRight(o.Host, "/") + "/i/v1/", now: o.Now.UnixMilli()}
	if err := s.checkKey(ctx); err != nil {
		return nil, err
	}
	fmt.Fprintf(progress, "seed: %d visits over %d days, %d recorded, %d at a time, seed %d\n",
		o.Visits, o.Days, min(o.Recorded, o.Visits), o.Concurrency, o.Seed)

	start := time.Now()
	gen := newGenerator(seedPlan{Seed: o.Seed, Days: o.Days, Visits: o.Visits, Recorded: o.Recorded, Now: s.now})
	// The first visit goes alone: its answer says whether analytics is on.
	if first := gen.next(); first != nil {
		if s.visit(ctx, first) == http.StatusForbidden {
			return nil, errAnalyticsOff
		}
	}
	jobs := make(chan *Visit)
	var wg sync.WaitGroup
	for range o.Concurrency {
		wg.Go(func() {
			for v := range jobs {
				s.visit(ctx, v)
			}
		})
	}
	done := make(chan struct{})
	go s.ticker(progress, start, done)
feed:
	for v := gen.next(); v != nil; v = gen.next() {
		select {
		case jobs <- v:
		case <-ctx.Done():
			break feed
		}
	}
	close(jobs)
	wg.Wait()
	close(done)
	return s.report(time.Since(start)), nil
}

// checkKey fails fast when the key is unknown.
func (s *seeder) checkKey(ctx context.Context) error {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, s.base+"config?key="+s.o.Key, nil)
	res, err := s.client.Do(req)
	if err != nil {
		return fmt.Errorf("seed: reach %s: %w", s.o.Host, err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	if res.StatusCode != http.StatusOK || !bytes.Contains(body, []byte(`"recording":true`)) {
		return fmt.Errorf("seed: the server does not record for key %s (status %d)", s.o.Key, res.StatusCode)
	}
	return nil
}

func (s *seeder) ticker(w io.Writer, start time.Time, done <-chan struct{}) {
	t := time.NewTicker(5 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-done:
			return
		case <-t.C:
			fmt.Fprintf(w, "  %5.0fs  %d visits  %d events  %d recordings  %d failed\n",
				time.Since(start).Seconds(), s.visits.Load(), s.events.Load(), s.recordings.Load(), s.failed.Load())
		}
	}
}

// visit sends one visit: its hits in order, its recording and its
// feedback. It returns the status of the first hit, or 0 without one.
func (s *seeder) visit(ctx context.Context, v *Visit) int {
	if v.Live {
		// The run took a while: bring the visit back to the last minutes.
		v.shift(max(time.Now().UnixMilli()-s.now, 0))
	}
	ua := v.Visitor.Agent.ua
	firstStatus, ok := 0, true
	if s.o.Analytics {
		for i, h := range v.hits() {
			body, _ := json.Marshal(h)
			status := s.post(ctx, "hit", body, ua)
			if i == 0 {
				firstStatus = status
				if status == http.StatusForbidden {
					return status // analytics is off: nothing of this visit is wanted
				}
			}
			if status != http.StatusNoContent {
				ok = false
				continue
			}
			s.hits.Add(1)
			s.events.Add(int64(len(h.Events)))
			for _, e := range h.Events {
				if e.K == "page" {
					s.pageViews.Add(1)
				}
			}
		}
		if f := v.Feedback; f != nil && ok {
			body, _ := json.Marshal(map[string]any{"v": 1, "visitId": f.VisitID, "anonymousId": f.AnonymousID,
				"path": f.Path, "text": f.Text, "email": f.Email, "at": f.At})
			if s.post(ctx, "feedback", body, ua) == http.StatusNoContent {
				s.feedback.Add(1)
			}
		}
	}
	if v.Recorded {
		ok = s.record(ctx, v, ua) && ok
	}
	if ok && (s.o.Analytics || v.Recorded) {
		s.visits.Add(1)
	}
	return firstStatus
}

// record sends the visit's recording, batch by batch.
func (s *seeder) record(ctx context.Context, v *Visit, ua string) bool {
	ok := true
	for _, b := range recording(v, &s.page) {
		var gz bytes.Buffer
		zw := gzip.NewWriter(&gz)
		zw.Write(b.Events)
		zw.Close()
		body, err := envelope.Encode(b.Meta, gz.Bytes())
		if err != nil {
			s.fail("encode")
			return false
		}
		if s.post(ctx, "batch", body, ua) != http.StatusNoContent {
			ok = false
			continue
		}
		s.batches.Add(1)
	}
	if ok {
		s.recordings.Add(1)
	}
	return ok
}

// post sends one body and returns the status (0 when the request did not
// get through). 503 and 429 wait for Retry-After and go again, a few
// times; anything but 204 is counted as a failure.
func (s *seeder) post(ctx context.Context, route string, body []byte, ua string) int {
	for attempt := 0; ; attempt++ {
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost, s.base+route+"?key="+s.o.Key, bytes.NewReader(body))
		req.Header.Set("Content-Type", "text/plain;charset=UTF-8") // what sendBeacon sends
		req.Header.Set("User-Agent", ua)
		res, err := s.client.Do(req)
		if err != nil {
			if ctx.Err() == nil {
				s.fail(route + ": network")
			}
			return 0
		}
		io.Copy(io.Discard, res.Body)
		res.Body.Close()
		busy := res.StatusCode == http.StatusServiceUnavailable || res.StatusCode == http.StatusTooManyRequests
		if busy && attempt < seedRetries {
			s.retries.Add(1)
			select {
			case <-ctx.Done():
				return 0
			case <-time.After(retryAfter(res.Header.Get("Retry-After"))):
			}
			continue
		}
		if res.StatusCode != http.StatusNoContent {
			s.fail(fmt.Sprintf("%s: status %d", route, res.StatusCode))
			return res.StatusCode
		}
		s.bytes.Add(int64(len(body)))
		return res.StatusCode
	}
}

// retryAfter reads a Retry-After of seconds: at least a moment, at most 30 s.
func retryAfter(header string) time.Duration {
	secs, err := strconv.Atoi(strings.TrimSpace(header))
	if err != nil || secs < 1 {
		return 500 * time.Millisecond
	}
	return time.Duration(min(secs, 30)) * time.Second
}

func (s *seeder) fail(kind string) {
	s.failed.Add(1)
	s.mu.Lock()
	s.errors[kind]++
	s.mu.Unlock()
}

func (s *seeder) report(elapsed time.Duration) *SeedReport {
	return &SeedReport{Elapsed: elapsed, Visits: s.visits.Load(), PageViews: s.pageViews.Load(), Events: s.events.Load(),
		Hits: s.hits.Load(), Recordings: s.recordings.Load(), Batches: s.batches.Load(), Feedback: s.feedback.Load(),
		Bytes: s.bytes.Load(), Retries: s.retries.Load(), Failed: s.failed.Load(), Errors: s.errors}
}

func (rep *SeedReport) String() string {
	secs := max(rep.Elapsed.Seconds(), 0.001)
	var b strings.Builder
	fmt.Fprintf(&b, "elapsed     %s\n", rep.Elapsed.Round(time.Millisecond))
	fmt.Fprintf(&b, "visits      %d (%.0f/s)\n", rep.Visits, float64(rep.Visits)/secs)
	fmt.Fprintf(&b, "page views  %d\n", rep.PageViews)
	fmt.Fprintf(&b, "events      %d in %d hits\n", rep.Events, rep.Hits)
	fmt.Fprintf(&b, "recordings  %d in %d batches\n", rep.Recordings, rep.Batches)
	fmt.Fprintf(&b, "feedback    %d\n", rep.Feedback)
	fmt.Fprintf(&b, "bytes       %.1f MB (%.2f MB/s)\n", float64(rep.Bytes)/1e6, float64(rep.Bytes)/1e6/secs)
	if len(rep.Errors) == 0 {
		fmt.Fprintf(&b, "failures    none (%d retries)\n", rep.Retries)
		return b.String()
	}
	kinds := make([]string, 0, len(rep.Errors))
	for k := range rep.Errors {
		kinds = append(kinds, k)
	}
	sort.Strings(kinds)
	parts := make([]string, len(kinds))
	for i, k := range kinds {
		parts[i] = fmt.Sprintf("%s: %d", k, rep.Errors[k])
	}
	fmt.Fprintf(&b, "failures    %d (%s), %d retries\n", rep.Failed, strings.Join(parts, ", "), rep.Retries)
	return b.String()
}
