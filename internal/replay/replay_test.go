package replay

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func events(seq, n, size int) []Event {
	out := make([]Event, n)
	for i := range out {
		raw := fmt.Sprintf(`{"type":3,"timestamp":%d,"data":{"pad":%q}}`, seq*1000+i, strings.Repeat("x", size))
		out[i] = Event{Raw: json.RawMessage(raw), Ts: int64(seq*1000 + i)}
	}
	return out
}

func TestPackerChunksAndRoundTrip(t *testing.T) {
	codec, err := NewCodec()
	if err != nil {
		t.Fatal(err)
	}
	p := NewPacker(codec)
	blocks := [][]Event{events(0, 6, 100_000), events(1, 6, 100_000), events(2, 25, 100_000), events(3, 1, 10)}
	var want []json.RawMessage
	for seq, evs := range blocks {
		p.AddBlock(int64(seq), evs)
		for _, e := range evs {
			want = append(want, e.Raw)
		}
	}
	chunks := p.End()

	// 0 and 1 do not fit together; 2 is split across three chunks; 3 rides along.
	type span struct{ first, last int64 }
	var spans []span
	for _, c := range chunks {
		spans = append(spans, span{c.FirstSeq, c.LastSeq})
	}
	if fmt.Sprint(spans) != "[{0 0} {1 1} {2 2} {2 2} {2 3}]" {
		t.Fatalf("chunk spans = %v", spans)
	}

	var out bytes.Buffer
	out.WriteByte('[')
	aw := ArrayWriter{W: &out}
	total := 0
	for _, c := range chunks {
		array, err := codec.DecodeChunk(p.Bytes()[c.Offset : c.Offset+c.Length])
		if err != nil {
			t.Fatal(err)
		}
		if err := aw.WriteArray(array); err != nil {
			t.Fatal(err)
		}
		total += c.Events
	}
	out.WriteByte(']')
	var got []json.RawMessage
	if err := json.Unmarshal(out.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if len(got) != len(want) || total != len(want) {
		t.Fatalf("got %d events (chunks say %d), want %d", len(got), total, len(want))
	}
	for i := range want {
		if !bytes.Equal(got[i], want[i]) {
			t.Fatalf("event %d differs", i)
		}
	}
	if chunks[0].FirstTs != 0 || chunks[4].LastTs != 3000 {
		t.Fatalf("timestamps %+v", chunks)
	}
}

func TestAddChunkCopies(t *testing.T) {
	codec, _ := NewCodec()
	p := NewPacker(codec)
	p.AddBlock(0, events(0, 2, 5))
	first := p.End()
	q := NewPacker(codec)
	q.AddBlock(9, events(9, 1, 5)) // another recording before it in the object
	q.End()
	raw := p.Bytes()[first[0].Offset : first[0].Offset+first[0].Length]
	q.AddChunk(raw, first[0])
	q.AddBlock(1, events(1, 1, 5))
	got := q.End()
	if len(got) != 2 || got[0].Offset == 0 || got[0].Events != 2 || got[1].FirstSeq != 1 {
		t.Fatalf("chunks = %+v", got)
	}
	array, err := codec.DecodeChunk(q.Bytes()[got[0].Offset : got[0].Offset+got[0].Length])
	if err != nil || !strings.HasPrefix(string(array), `[{"type":3,"timestamp":0`) {
		t.Fatalf("copied chunk: %s %v", array, err)
	}
}

func TestArrayWriter(t *testing.T) {
	var b bytes.Buffer
	aw := ArrayWriter{W: &b}
	for _, a := range []string{`[1,2]`, ` [ ] `, "[3]\n"} {
		if err := aw.WriteArray([]byte(a)); err != nil {
			t.Fatal(err)
		}
	}
	if b.String() != "1,2,3" {
		t.Fatalf("got %q", b.String())
	}
	if err := aw.WriteArray([]byte(`{"a":1}`)); err == nil {
		t.Fatal("object accepted")
	}
}

func TestSplitEvents(t *testing.T) {
	evs, err := SplitEvents([]byte(`[{"type":4,"timestamp":5},{"type":2,"timestamp":6,"data":{}}]`))
	if err != nil || len(evs) != 2 || evs[1].Ts != 6 {
		t.Fatalf("%v %v", evs, err)
	}
	if _, err := SplitEvents([]byte(`{}`)); err == nil {
		t.Fatal("object accepted")
	}
}
