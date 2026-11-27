package replay

import (
	"bytes"

	"github.com/dimmihq/kimmi/internal/store"
)

// Packer lays out the sealed chunks of many recordings back to back in one
// object. Use it per recording: AddChunk, and BeginBlock/AddEvent/EndBlock
// (or AddBlock) in seq order, then End. Reset reuses its memory for the
// next object.
type Packer struct {
	codec   *Codec
	obj     []byte
	session []store.Chunk

	pending  bytes.Buffer // JSON array under construction
	events   int
	firstTs  int64
	lastTs   int64
	firstSeq int64
	lastSeq  int64
}

// NewPacker starts an empty object.
func NewPacker(c *Codec) *Packer { return &Packer{codec: c} }

// Len is the object size so far.
func (p *Packer) Len() int { return len(p.obj) }

// Bytes is the object.
func (p *Packer) Bytes() []byte { return p.obj }

// Reset empties the object, keeping its memory.
func (p *Packer) Reset() {
	p.obj, p.session = p.obj[:0], nil
	p.pending.Reset()
	p.events, p.firstTs, p.lastTs = 0, 0, 0
}

// AddChunk copies an already sealed chunk (its compressed bytes) as is.
func (p *Packer) AddChunk(compressed []byte, meta store.Chunk) {
	p.flush()
	meta.Offset, meta.Length = int64(len(p.obj)), int64(len(compressed))
	p.obj = append(p.obj, compressed...)
	p.session = append(p.session, meta)
}

// AddBlock appends one block's events. A chunk closes before a block that
// would push it past ChunkTarget; a block bigger than that alone is split
// between events.
func (p *Packer) AddBlock(seq int64, events []Event) {
	size := 0
	for _, e := range events {
		size += len(e.Raw) + 1
	}
	p.BeginBlock(size)
	for _, e := range events {
		p.AddEvent(seq, e.Raw, e.Ts)
	}
	p.EndBlock()
}

// BeginBlock starts a block of about size decoded bytes, closing the
// current chunk first when the block would not fit in it.
func (p *Packer) BeginBlock(size int) {
	if p.pending.Len()+size > ChunkTarget {
		p.flush()
	}
}

// AddEvent appends one event of block seq; raw is copied.
func (p *Packer) AddEvent(seq int64, raw []byte, ts int64) {
	if p.pending.Len() >= ChunkTarget {
		p.flush()
	}
	if p.events == 0 {
		p.pending.WriteByte('[')
		p.firstTs, p.lastTs, p.firstSeq = ts, ts, seq
	} else {
		p.pending.WriteByte(',')
	}
	p.pending.Write(raw)
	p.events++
	p.lastSeq = seq
	p.firstTs, p.lastTs = min(p.firstTs, ts), max(p.lastTs, ts)
}

// EndBlock closes the chunk when it is full.
func (p *Packer) EndBlock() {
	if p.pending.Len() >= ChunkTarget {
		p.flush()
	}
}

func (p *Packer) flush() {
	if p.events == 0 {
		return
	}
	p.pending.WriteByte(']')
	start := len(p.obj)
	p.obj = p.codec.enc.EncodeAll(p.pending.Bytes(), p.obj)
	p.session = append(p.session, store.Chunk{
		Offset: int64(start), Length: int64(len(p.obj) - start),
		FirstTs: p.firstTs, LastTs: p.lastTs, Events: p.events, FirstSeq: p.firstSeq, LastSeq: p.lastSeq,
	})
	p.pending.Reset()
	p.events, p.firstTs, p.lastTs = 0, 0, 0
}

// End closes the current recording and returns its chunks.
func (p *Packer) End() []store.Chunk {
	p.flush()
	out := p.session
	p.session = nil
	return out
}
