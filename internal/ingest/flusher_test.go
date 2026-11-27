package ingest

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/dimmihq/kimmi/internal/blob"
	"github.com/dimmihq/kimmi/internal/envelope"
	"github.com/dimmihq/kimmi/internal/guard"
	"github.com/dimmihq/kimmi/internal/store"
)

type fakeStore struct {
	fail   error
	blocks []store.IngestBlock
}

func (f *fakeStore) ApplyFlush(_ context.Context, blocks []store.IngestBlock, _ int64) error {
	if f.fail != nil {
		return f.fail
	}
	f.blocks = append(f.blocks, blocks...)
	return nil
}

func quiet() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func payload(n int, b byte) []byte { return bytes.Repeat([]byte{b}, n) }

func TestFlusherWritesSlabsInOrder(t *testing.T) {
	b, _ := blob.NewLocal(t.TempDir())
	st := &fakeStore{}
	f := NewFlusher(b, st, "n", &Stats{}, quiet(), Limits{Buffer: 8 << 20})
	sizes := []int{10, slabSize - 3, 7, 2*slabSize + 1, 1}
	for i, n := range sizes {
		if err := f.Add(store.IngestBlock{Block: store.Block{SessionID: "s", Seq: int64(i), ProjectID: "p"}}, payload(n, byte('a'+i))); err != nil {
			t.Fatal(err)
		}
	}
	if err := f.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	if f.Buffered() != 0 || len(st.blocks) != len(sizes) {
		t.Fatalf("buffered %d, %d blocks", f.Buffered(), len(st.blocks))
	}
	for i, bl := range st.blocks {
		got, err := b.Get(context.Background(), bl.FileKey, bl.Offset, bl.Length)
		if err != nil || !bytes.Equal(got, payload(sizes[i], byte('a'+i))) {
			t.Fatalf("block %d: %d bytes at %d, err %v", i, len(got), bl.Offset, err)
		}
	}
}

type failingBlob struct {
	blob.Store
	fail bool
}

func (f *failingBlob) PutReader(ctx context.Context, key string, r io.Reader, size int64) error {
	if f.fail {
		return errors.New("storage is down")
	}
	return f.Store.PutReader(ctx, key, r, size)
}

func TestFlusherCapsAndRetries(t *testing.T) {
	local, _ := blob.NewLocal(t.TempDir())
	b := &failingBlob{Store: local, fail: true}
	st := &fakeStore{}
	f := NewFlusher(b, st, "n", &Stats{}, quiet(), Limits{Buffer: 4 << 20, Project: 2 << 20})
	add := func(project string, seq int64, n int) error {
		return f.Add(store.IngestBlock{Block: store.Block{SessionID: project + "s", Seq: seq, ProjectID: project}}, payload(n, 'x'))
	}
	if err := add("a", 0, 1<<20); err != nil {
		t.Fatal(err)
	}
	if err := f.Flush(context.Background()); err == nil {
		t.Fatal("flush to broken storage succeeded")
	}
	// The failed flush is still held and still counts.
	if err := add("a", 1, 1<<20); err != nil {
		t.Fatal(err)
	}
	if err := add("a", 2, 1); !errors.Is(err, ErrBufferFull) {
		t.Fatalf("project over its share: %v", err)
	}
	if err := add("b", 0, 2<<20); err != nil {
		t.Fatal(err)
	}
	if err := add("c", 0, 1); !errors.Is(err, ErrBufferFull) {
		t.Fatalf("node over its buffer: %v", err)
	}
	b.fail = false
	if err := f.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(st.blocks) != 3 || f.Buffered() != 0 {
		t.Fatalf("%d blocks written, %d still buffered", len(st.blocks), f.Buffered())
	}
	if err := add("a", 3, 2<<20); err != nil {
		t.Fatalf("room is not given back after a flush: %v", err)
	}
}

func TestPartsReader(t *testing.T) {
	r := &partsReader{parts: [][]byte{[]byte("abc"), []byte("de"), []byte("fghij")}, size: 10}
	all, _ := io.ReadAll(r)
	if string(all) != "abcdefghij" {
		t.Fatalf("read %q", all)
	}
	p := make([]byte, 4)
	if n, err := r.ReadAt(p, 2); n != 4 || err != nil || string(p) != "cdef" {
		t.Fatalf("ReadAt: %d %v %q", n, err, p)
	}
	if n, err := r.ReadAt(p, 8); n != 2 || err != io.EOF {
		t.Fatalf("ReadAt at the end: %d %v", n, err)
	}
	r.Seek(5, io.SeekStart)
	rest, _ := io.ReadAll(r)
	if string(rest) != "fghij" {
		t.Fatalf("after seek %q", rest)
	}
}

func batchBody(t *testing.T, seq int64) []byte {
	var gz bytes.Buffer
	gz.Write([]byte{0x1f, 0x8b})
	gz.Write(make([]byte, 30))
	b, err := envelope.Encode(envelope.Meta{V: 1, SessionID: "s", AnonymousID: "a", Seq: seq, StartedAt: 1, FirstTs: 1, LastTs: 2}, gz.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func newTestHandler(t *testing.T, limit *guard.Limiter, maxReading int64) (*Handler, *http.ServeMux) {
	b, _ := blob.NewLocal(t.TempDir())
	cache := &Cache{byKey: map[string]*Project{"km_pub_k": {ID: "p", OrgID: "o"}}}
	h := &Handler{Cache: cache, Flusher: NewFlusher(b, &fakeStore{}, "n", &Stats{}, quiet(), Limits{Buffer: 8 << 20}),
		Stats: &Stats{}, Limit: limit, MaxReading: maxReading}
	mux := http.NewServeMux()
	h.Register(mux)
	return h, mux
}

func post(mux http.Handler, body []byte, remote string) *httptest.ResponseRecorder {
	req := httptest.NewRequest("POST", "/i/v1/batch?key=km_pub_k", bytes.NewReader(body))
	req.RemoteAddr = remote
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

func TestBatchRateLimit(t *testing.T) {
	_, mux := newTestHandler(t, guard.NewLimiter(1, 2), 0)
	for i := range 2 {
		if rec := post(mux, batchBody(t, int64(i)), "198.51.100.1:1"); rec.Code != 204 {
			t.Fatalf("batch %d: %d", i, rec.Code)
		}
	}
	rec := post(mux, batchBody(t, 2), "198.51.100.1:1")
	if rec.Code != 429 || rec.Header().Get("Retry-After") == "" {
		t.Fatalf("over the limit: %d %v", rec.Code, rec.Header())
	}
	if rec := post(mux, batchBody(t, 3), "198.51.100.2:1"); rec.Code != 204 {
		t.Fatalf("another address was limited: %d", rec.Code)
	}
}

func TestBatchReadBudget(t *testing.T) {
	h, mux := newTestHandler(t, nil, 1000)
	h.reading.Store(990) // other bodies are being read
	if rec := post(mux, batchBody(t, 0), "198.51.100.1:1"); rec.Code != 503 {
		t.Fatalf("over the read budget: %d", rec.Code)
	}
	h.reading.Store(0)
	if rec := post(mux, batchBody(t, 0), "198.51.100.1:1"); rec.Code != 204 {
		t.Fatalf("within the budget: %d", rec.Code)
	}
	if h.reading.Load() != 0 {
		t.Fatalf("budget not released: %d", h.reading.Load())
	}
	// A body without a declared length still works.
	req := httptest.NewRequest("POST", "/i/v1/batch?key=km_pub_k", io.MultiReader(strings.NewReader(""), bytes.NewReader(batchBody(t, 1))))
	req.ContentLength = -1
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != 204 {
		t.Fatalf("chunked body: %d", rec.Code)
	}
}

func TestBufferPool(t *testing.T) {
	for _, n := range []int{0, 1, 1000, 4096, 4097, 5 << 20} {
		b := buffers.get(n)
		if len(*b) != n || cap(*b) < n {
			t.Fatalf("get(%d): len %d cap %d", n, len(*b), cap(*b))
		}
		buffers.put(b)
	}
	big, err := readBody(bytes.NewReader(payload(300<<10, 'z')), -1)
	if err != nil || len(*big) != 300<<10 || (*big)[len(*big)-1] != 'z' {
		t.Fatalf("readBody of unknown length: %v", err)
	}
}
