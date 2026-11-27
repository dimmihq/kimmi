package blob

import (
	"bytes"
	"context"
	"errors"
	"os"
	"slices"
	"testing"

	"github.com/google/uuid"
)

func TestLocal(t *testing.T) {
	s, err := NewLocal(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	runSuite(t, s)
}

func TestS3(t *testing.T) {
	endpoint := os.Getenv("KIMMI_TEST_S3_ENDPOINT")
	if endpoint == "" {
		t.Skip("KIMMI_TEST_S3_ENDPOINT not set")
	}
	s, err := NewS3(context.Background(), S3Config{
		Endpoint:  endpoint,
		Bucket:    "kimmi-test-" + uuid.NewString()[:8],
		Region:    "us-east-1",
		AccessKey: os.Getenv("KIMMI_TEST_S3_ACCESS_KEY"),
		SecretKey: os.Getenv("KIMMI_TEST_S3_SECRET_KEY"),
	})
	if err != nil {
		t.Fatal(err)
	}
	runSuite(t, s)
}

func runSuite(t *testing.T, s Store) {
	ctx := context.Background()
	data := []byte("0123456789abcdef")
	for _, k := range []string{"live/2026-11-27/a.bin", "live/2026-11-27/b.bin", "sealed/30d/p/x.bin"} {
		if err := s.Put(ctx, k, data); err != nil {
			t.Fatal(err)
		}
	}

	t.Run("put reader", func(t *testing.T) {
		if err := s.PutReader(ctx, "live/2026-11-27/r.bin", bytes.NewReader(data), int64(len(data))); err != nil {
			t.Fatal(err)
		}
		got, err := s.Get(ctx, "live/2026-11-27/r.bin", 2, 3)
		if err != nil || string(got) != "234" {
			t.Fatalf("got %q %v", got, err)
		}
		if err := s.PutReader(ctx, "live/2026-11-27/short.bin", bytes.NewReader(data[:4]), 10); err == nil {
			t.Fatal("a short reader was stored")
		}
		if _, err := s.Get(ctx, "live/2026-11-27/short.bin", 0, -1); !errors.Is(err, ErrNotFound) {
			t.Fatalf("short object left behind: %v", err)
		}
		if err := s.Delete(ctx, "live/2026-11-27/r.bin"); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("range reads", func(t *testing.T) {
		for _, c := range []struct {
			off, n int64
			want   string
		}{{0, -1, "0123456789abcdef"}, {4, 3, "456"}, {10, -1, "abcdef"}, {15, 1, "f"}, {3, 0, ""}} {
			got, err := s.Get(ctx, "live/2026-11-27/a.bin", c.off, c.n)
			if err != nil {
				t.Fatalf("Get(%d,%d): %v", c.off, c.n, err)
			}
			if !bytes.Equal(got, []byte(c.want)) {
				t.Fatalf("Get(%d,%d) = %q, want %q", c.off, c.n, got, c.want)
			}
		}
	})

	t.Run("missing", func(t *testing.T) {
		if _, err := s.Get(ctx, "live/nope.bin", 0, -1); !errors.Is(err, ErrNotFound) {
			t.Fatalf("err = %v, want ErrNotFound", err)
		}
	})

	t.Run("list by prefix", func(t *testing.T) {
		var keys []string
		for o, err := range s.List(ctx, "live/") {
			if err != nil {
				t.Fatal(err)
			}
			if o.Size != int64(len(data)) {
				t.Fatalf("%s size %d", o.Key, o.Size)
			}
			keys = append(keys, o.Key)
		}
		slices.Sort(keys)
		if !slices.Equal(keys, []string{"live/2026-11-27/a.bin", "live/2026-11-27/b.bin"}) {
			t.Fatalf("keys = %v", keys)
		}
	})

	t.Run("overwrite and delete", func(t *testing.T) {
		if err := s.Put(ctx, "live/2026-11-27/a.bin", []byte("new")); err != nil {
			t.Fatal(err)
		}
		got, _ := s.Get(ctx, "live/2026-11-27/a.bin", 0, -1)
		if string(got) != "new" {
			t.Fatalf("got %q", got)
		}
		for _, k := range []string{"live/2026-11-27/a.bin", "live/2026-11-27/b.bin", "sealed/30d/p/x.bin", "never/was.bin"} {
			if err := s.Delete(ctx, k); err != nil {
				t.Fatal(err)
			}
		}
		for o, err := range s.List(ctx, "") {
			t.Fatalf("left behind %v %v", o, err)
		}
	})
}
