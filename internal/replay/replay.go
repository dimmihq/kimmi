// Package replay converts recordings between their stored forms: live blocks
// (the SDK's gzip of a JSON array of rrweb events) and sealed chunks (zstd
// frames of a JSON array, about 1 MB of events each), and streams them back
// out as one JSON array.
package replay

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"

	"github.com/klauspost/compress/gzip"
	"github.com/klauspost/compress/zstd"
)

// ChunkTarget is the uncompressed size at which a sealed chunk is closed.
const ChunkTarget = 1 << 20

// maxDecoded bounds the decoded bytes of one block, against gzip bombs.
// Blocks are streamed, so this bounds work, not memory.
const maxDecoded = 256 << 20

// maxChunk bounds a decoded sealed chunk: chunks close near ChunkTarget,
// and only one oversized event can push one past it.
const maxChunk = MaxEvent + 2*ChunkTarget

// Codec holds the zstd encoder and decoder; both are safe for concurrent
// use. The encoder runs one frame at a time (only the sealer encodes) with
// a window no larger than a chunk, which keeps its state small.
type Codec struct {
	enc *zstd.Encoder
	dec *zstd.Decoder
}

// NewCodec builds a Codec.
func NewCodec() (*Codec, error) {
	enc, err := zstd.NewWriter(nil, zstd.WithEncoderLevel(zstd.SpeedDefault),
		zstd.WithEncoderConcurrency(1), zstd.WithWindowSize(2*ChunkTarget), zstd.WithLowerEncoderMem(true))
	if err != nil {
		return nil, fmt.Errorf("zstd encoder: %w", err)
	}
	dec, err := zstd.NewReader(nil, zstd.WithDecoderMaxMemory(maxChunk), zstd.WithDecoderConcurrency(2),
		zstd.WithDecoderLowmem(true))
	if err != nil {
		return nil, fmt.Errorf("zstd decoder: %w", err)
	}
	return &Codec{enc: enc, dec: dec}, nil
}

var (
	gzipReaders = sync.Pool{}
	bufReaders  = sync.Pool{New: func() any { return bufio.NewReaderSize(nil, 32<<10) }}
)

// ScanGzip streams the events of a live block (the gzip of a JSON array)
// to fn without decoding the block whole. Each event passed to fn is
// already checked to be valid JSON; the slice is reused after fn returns.
// Events before a damaged one have been passed when the error is returned.
func (c *Codec) ScanGzip(b []byte, fn func(event []byte) error) error {
	zr, _ := gzipReaders.Get().(*gzip.Reader)
	var err error
	if zr == nil {
		zr, err = gzip.NewReader(bytes.NewReader(b))
	} else {
		err = zr.Reset(bytes.NewReader(b))
	}
	if err != nil {
		return fmt.Errorf("gunzip block: %w", err)
	}
	defer gzipReaders.Put(zr)
	br := bufReaders.Get().(*bufio.Reader)
	br.Reset(io.LimitReader(zr, maxDecoded))
	defer func() { br.Reset(nil); bufReaders.Put(br) }()
	err = ScanArray(br, MaxEvent, func(ev []byte) error {
		if !json.Valid(ev) {
			return errors.New("an event is not valid JSON")
		}
		return fn(ev)
	})
	if err != nil {
		return fmt.Errorf("gunzip block: %w", err)
	}
	return nil
}

// GzipSize is the decoded size a gzip stream declares in its trailer
// (modulo 4 GiB, and only of its last member): a hint, never trusted for
// memory.
func GzipSize(b []byte) int {
	if len(b) < 18 {
		return 0
	}
	return int(binary.LittleEndian.Uint32(b[len(b)-4:]))
}

// DecodeChunk decodes a sealed chunk.
func (c *Codec) DecodeChunk(b []byte) ([]byte, error) {
	out, err := c.dec.DecodeAll(b, nil)
	if err != nil {
		return nil, fmt.Errorf("decode chunk: %w", err)
	}
	return out, nil
}

// Event is one rrweb event, untouched, with its timestamp.
type Event struct {
	Raw json.RawMessage
	Ts  int64
}

// SplitEvents parses a JSON array of rrweb events.
func SplitEvents(array []byte) ([]Event, error) {
	var raws []json.RawMessage
	if err := json.Unmarshal(array, &raws); err != nil {
		return nil, fmt.Errorf("events are not a JSON array: %w", err)
	}
	out := make([]Event, len(raws))
	for i, raw := range raws {
		var head struct {
			Timestamp int64 `json:"timestamp"`
		}
		_ = json.Unmarshal(raw, &head)
		out[i] = Event{Raw: raw, Ts: head.Timestamp}
	}
	return out, nil
}

// ArrayWriter writes the elements of several JSON arrays as one array body
// (without the brackets), so a long recording streams without being held in
// memory as a whole.
type ArrayWriter struct {
	W     io.Writer
	wrote bool
}

// WriteElement appends one element.
func (aw *ArrayWriter) WriteElement(e []byte) error {
	if aw.wrote {
		if _, err := aw.W.Write([]byte{','}); err != nil {
			return err
		}
	}
	aw.wrote = true
	_, err := aw.W.Write(e)
	return err
}

// WriteArray appends the elements of the JSON array a.
func (aw *ArrayWriter) WriteArray(a []byte) error {
	a = bytes.TrimSpace(a)
	if len(a) < 2 || a[0] != '[' || a[len(a)-1] != ']' {
		return errors.New("not a JSON array")
	}
	inner := bytes.TrimSpace(a[1 : len(a)-1])
	if len(inner) == 0 {
		return nil
	}
	if aw.wrote {
		if _, err := aw.W.Write([]byte{','}); err != nil {
			return err
		}
	}
	aw.wrote = true
	_, err := aw.W.Write(inner)
	return err
}
