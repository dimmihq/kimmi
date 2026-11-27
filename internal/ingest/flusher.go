package ingest

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"sync"
	"time"

	"github.com/dimmihq/kimmi/internal/blob"
	"github.com/dimmihq/kimmi/internal/store"
)

// ErrBufferFull is returned when flushing has fallen too far behind, for
// the node or for one project; the handler answers 503 and the SDK retries.
var ErrBufferFull = errors.New("ingest buffer full")

// FlushStore is the store method the flusher needs.
type FlushStore interface {
	ApplyFlush(ctx context.Context, blocks []store.IngestBlock, at int64) error
}

// slabSize is the unit the buffer grows by. Payloads are copied back to
// back into slabs, so the buffer holds the bytes it was given (plus one
// partly filled slab) and the slabs, written in order, are the live object.
const slabSize = 256 << 10

var slabs = sync.Pool{New: func() any { b := make([]byte, slabSize); return &b }}

// segment is one run of buffered batches. Block offsets are relative to the
// segment's first byte.
type segment struct {
	blocks []store.IngestBlock
	slabs  []*[]byte
	size   int64
}

func (s *segment) append(payload []byte) {
	for len(payload) > 0 {
		used := int(s.size % slabSize)
		if used == 0 {
			s.slabs = append(s.slabs, slabs.Get().(*[]byte))
		}
		n := copy((*s.slabs[len(s.slabs)-1])[used:], payload)
		payload = payload[n:]
		s.size += int64(n)
	}
}

func (s *segment) release() {
	for _, b := range s.slabs {
		slabs.Put(b)
	}
	s.slabs = nil
}

// Limits bound a Flusher's memory.
type Limits struct {
	// Buffer caps every byte buffered on the node; Project caps one
	// project's share. Past either, Add returns ErrBufferFull.
	Buffer, Project int64
}

// Flusher buffers accepted batches in memory and writes them out every
// interval as one live object plus one database transaction.
type Flusher struct {
	blob  blob.Store
	store FlushStore
	node  string
	stats *Stats
	log   *slog.Logger
	kick  chan struct{}

	maxBuffer, maxProject, flushAt int64

	mu        sync.Mutex
	cur       *segment
	retry     []*segment // a failed flush, written first next time
	size      int64      // every buffered byte: cur, retry and a flush in progress
	byProject map[string]int64

	writing sync.Mutex // one flush at a time
	lastKey int64
}

// NewFlusher returns an empty buffer that writes live objects named after node.
func NewFlusher(b blob.Store, s FlushStore, node string, stats *Stats, log *slog.Logger, lim Limits) *Flusher {
	if lim.Buffer <= 0 {
		lim.Buffer = 32 << 20
	}
	if lim.Project <= 0 || lim.Project > lim.Buffer {
		lim.Project = lim.Buffer
	}
	return &Flusher{blob: b, store: s, node: node, stats: stats, log: log, kick: make(chan struct{}, 1),
		maxBuffer: lim.Buffer, maxProject: lim.Project, flushAt: max(min(8<<20, lim.Buffer/4), 1),
		cur: &segment{}, byProject: map[string]int64{}}
}

// Add copies one batch's payload into the buffer; the caller may reuse
// payload as soon as Add returns.
func (f *Flusher) Add(b store.IngestBlock, payload []byte) error {
	n := int64(len(payload))
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.size+n > f.maxBuffer || f.byProject[b.ProjectID]+n > f.maxProject {
		return ErrBufferFull
	}
	b.Offset, b.Length = f.cur.size, n
	f.cur.append(payload)
	f.cur.blocks = append(f.cur.blocks, b)
	f.size += n
	f.byProject[b.ProjectID] += n
	if f.cur.size >= f.flushAt {
		select {
		case f.kick <- struct{}{}:
		default:
		}
	}
	return nil
}

func (f *Flusher) take() []*segment {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := f.retry
	if len(f.cur.blocks) > 0 {
		out = append(out, f.cur)
		// The next segment will likely hold about as many batches.
		f.cur = &segment{blocks: make([]store.IngestBlock, 0, min(len(f.cur.blocks), 4096))}
	}
	f.retry = nil
	return out
}

// done forgets the bytes of segments that were written.
func (f *Flusher) done(segs []*segment) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, s := range segs {
		f.size -= s.size
		for _, b := range s.blocks {
			if f.byProject[b.ProjectID] -= b.Length; f.byProject[b.ProjectID] <= 0 {
				delete(f.byProject, b.ProjectID)
			}
		}
		s.release()
	}
}

// Flush writes everything buffered. On failure the batches stay queued for
// the next attempt; a live object written without its rows is collected later.
func (f *Flusher) Flush(ctx context.Context) error {
	f.writing.Lock()
	defer f.writing.Unlock()
	segs := f.take()
	if len(segs) == 0 {
		return nil
	}
	now := time.Now()
	ms := now.UnixMilli()
	if ms <= f.lastKey {
		ms = f.lastKey + 1
	}
	f.lastKey = ms
	key := fmt.Sprintf("live/%s/%s-%d.bin", now.UTC().Format(time.DateOnly), f.node, ms)

	var count int
	var total int64
	for _, s := range segs {
		count += len(s.blocks)
		total += s.size
	}
	blocks := make([]store.IngestBlock, 0, count)
	parts := make([][]byte, 0, total/slabSize+int64(len(segs)))
	var base int64
	for _, s := range segs {
		for _, b := range s.blocks {
			b.FileKey, b.Offset = key, base+b.Offset
			blocks = append(blocks, b)
		}
		rest := s.size
		for _, sl := range s.slabs {
			n := min(rest, slabSize)
			parts = append(parts, (*sl)[:n])
			rest -= n
		}
		base += s.size
	}
	err := f.blob.PutReader(ctx, key, &partsReader{parts: parts, size: total}, total)
	if err == nil {
		err = f.store.ApplyFlush(ctx, blocks, ms)
	}
	f.stats.flushed(now, err)
	if err != nil {
		f.mu.Lock()
		f.retry = segs
		f.mu.Unlock()
		return fmt.Errorf("flush %d batches: %w", count, err)
	}
	f.done(segs)
	return nil
}

// Run flushes every interval, and early when the buffer fills, until ctx
// ends; then it flushes one last time.
func (f *Flusher) Run(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			final, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
			if err := f.Flush(final); err != nil {
				f.log.Error("final ingest flush", "err", err)
			}
			cancel()
			return
		case <-t.C:
		case <-f.kick:
		}
		if err := f.Flush(ctx); err != nil {
			f.log.Error("ingest flush", "err", err)
		}
	}
}

// Buffered returns how many payload bytes are held, including a flush in
// progress.
func (f *Flusher) Buffered() int64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.size
}

// partsReader reads several byte slices as one stream. It also reads at
// offsets and seeks, so the S3 client can replay it when it retries.
type partsReader struct {
	parts [][]byte
	size  int64
	off   int64
}

func (r *partsReader) ReadAt(p []byte, off int64) (int, error) {
	if off < 0 {
		return 0, errors.New("negative offset")
	}
	n := 0
	var start int64
	for _, part := range r.parts {
		if n == len(p) {
			break
		}
		end := start + int64(len(part))
		if off >= start && off < end {
			c := copy(p[n:], part[off-start:])
			n += c
			off += int64(c)
		}
		start = end
	}
	if n < len(p) {
		return n, io.EOF
	}
	return n, nil
}

func (r *partsReader) Read(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	n, err := r.ReadAt(p, r.off)
	r.off += int64(n)
	if err == io.EOF && n > 0 {
		err = nil
	}
	return n, err
}

func (r *partsReader) Seek(offset int64, whence int) (int64, error) {
	switch whence {
	case io.SeekStart:
	case io.SeekCurrent:
		offset += r.off
	case io.SeekEnd:
		offset += r.size
	default:
		return 0, errors.New("bad whence")
	}
	if offset < 0 {
		return 0, errors.New("negative position")
	}
	r.off = offset
	return offset, nil
}
