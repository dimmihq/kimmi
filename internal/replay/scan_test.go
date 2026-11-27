package replay

import (
	"bytes"
	"compress/gzip"
	"errors"
	"strings"
	"testing"
)

func scanAll(in string, max int) ([]string, error) {
	var out []string
	err := ScanArray(strings.NewReader(in), max, func(e []byte) error {
		out = append(out, string(e))
		return nil
	})
	return out, err
}

func TestScanArray(t *testing.T) {
	good := map[string][]string{
		`[]`:                                     nil,
		` [ ] `:                                  nil,
		`[1]`:                                    {"1"},
		`[1, "a,]\"}" , {"x":[1,2]}]`:            {"1", `"a,]\"}"`, `{"x":[1,2]}`},
		"[\n{\"a\":{\"b\":\"]\"}}\n,\n[[]]\n]\n": {`{"a":{"b":"]"}}`, `[[]]`},
		`[{"s":"\\"}]`:                           {`{"s":"\\"}`},
	}
	for in, want := range good {
		got, err := scanAll(in, 1<<20)
		if err != nil || strings.Join(got, "|") != strings.Join(want, "|") {
			t.Errorf("%q: got %q, %v; want %q", in, got, err, want)
		}
	}
	for _, in := range []string{``, `{}`, `[1,]`, `[1`, `[{"a":1}`, `[1]x`, `["open]`, `[}]`, `[,1]`} {
		if _, err := scanAll(in, 1<<20); err == nil {
			t.Errorf("%q accepted", in)
		}
	}
	if _, err := scanAll(`[{"pad":"`+strings.Repeat("x", 100)+`"}]`, 50); !errors.Is(err, ErrEventTooLarge) {
		t.Fatalf("an oversized event: %v", err)
	}
}

func gz(s string) []byte {
	var b bytes.Buffer
	w := gzip.NewWriter(&b)
	w.Write([]byte(s))
	w.Close()
	return b.Bytes()
}

func TestScanGzip(t *testing.T) {
	codec, _ := NewCodec()
	raw := gz(`[{"type":4,"timestamp":1},{"type":3,"timestamp":2}]`)
	if GzipSize(raw) != 51 {
		t.Fatalf("size hint %d", GzipSize(raw))
	}
	var got []string
	if err := codec.ScanGzip(raw, func(e []byte) error { got = append(got, string(e)); return nil }); err != nil || len(got) != 2 {
		t.Fatalf("%v %v", got, err)
	}
	// A damaged event stops the block; the events before it were delivered.
	got = nil
	err := codec.ScanGzip(gz(`[{"timestamp":1},{"timestamp":2,,}]`), func(e []byte) error { got = append(got, string(e)); return nil })
	if err == nil || len(got) != 1 {
		t.Fatalf("damaged block: %v %v", got, err)
	}
	if err := codec.ScanGzip([]byte("not gzip at all......"), func([]byte) error { return nil }); err == nil {
		t.Fatal("not gzip accepted")
	}
}
