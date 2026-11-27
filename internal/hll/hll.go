// Package hll counts distinct things in a small, mergeable sketch: exactly
// while there are few, and as a HyperLogLog estimate after that. kimmi keeps
// one per day and breakdown row, so "unique visitors" over any window is a
// merge of a few sketches instead of a scan of every visit.
package hll

import (
	"encoding/binary"
	"errors"
	"math"
	"math/bits"
	"slices"
)

// Sketch is a set of 64-bit hashes of which only the size is wanted. The
// zero value is not usable: make one with New.
type Sketch struct {
	p      uint8    // 2^p registers once dense
	sparse []uint64 // sorted, distinct hashes; nil once dense
	dense  []byte   // one register per byte; nil while sparse
}

// New returns an empty sketch of precision p (4 to 16). The estimate's
// standard error is about 1.04/sqrt(2^p): 0.8% at 14, 3.3% at 10. Up to
// 2^p/8 distinct values are kept as they are and counted exactly.
func New(p uint8) *Sketch {
	return &Sketch{p: min(max(p, 4), 16)}
}

// Hash turns a string into the hash a sketch wants: FNV-1a, then mixed so
// that its high bits are as good as its low ones.
func Hash(s string) uint64 {
	h := uint64(14695981039346656037)
	for i := 0; i < len(s); i++ {
		h ^= uint64(s[i])
		h *= 1099511628211
	}
	h ^= h >> 33
	h *= 0xff51afd7ed558ccd
	h ^= h >> 33
	h *= 0xc4ceb9fe1a85ec53
	h ^= h >> 33
	return h
}

func (s *Sketch) limit() int { return (1 << s.p) / 8 }

// Add puts one hash in.
func (s *Sketch) Add(h uint64) {
	if s.dense != nil {
		s.register(h)
		return
	}
	i, found := slices.BinarySearch(s.sparse, h)
	if found {
		return
	}
	s.sparse = slices.Insert(s.sparse, i, h)
	if len(s.sparse) > s.limit() {
		s.densify()
	}
}

func (s *Sketch) register(h uint64) {
	i := h >> (64 - s.p)
	rank := uint8(bits.LeadingZeros64(h<<s.p|1<<(s.p-1))) + 1
	if rank > s.dense[i] {
		s.dense[i] = rank
	}
}

func (s *Sketch) densify() {
	s.dense = make([]byte, 1<<s.p)
	for _, h := range s.sparse {
		s.register(h)
	}
	s.sparse = nil
}

// Merge adds everything o has seen. Both must have the same precision.
func (s *Sketch) Merge(o *Sketch) {
	if o == nil || o.p != s.p {
		return
	}
	if o.dense == nil {
		for _, h := range o.sparse {
			s.Add(h)
		}
		return
	}
	if s.dense == nil {
		s.densify()
	}
	for i, r := range o.dense {
		if r > s.dense[i] {
			s.dense[i] = r
		}
	}
}

// Count is how many distinct hashes were added: exact while the sketch is
// sparse, an estimate after.
func (s *Sketch) Count() int {
	if s.dense == nil {
		return len(s.sparse)
	}
	m := float64(len(s.dense))
	sum, zeros := 0.0, 0
	for _, r := range s.dense {
		sum += 1 / float64(uint64(1)<<r)
		if r == 0 {
			zeros++
		}
	}
	alpha := 0.7213 / (1 + 1.079/m)
	estimate := alpha * m * m / sum
	if estimate <= 2.5*m && zeros > 0 {
		estimate = m * math.Log(m/float64(zeros)) // few values for the registers: count the empty ones
	}
	return int(estimate + 0.5)
}

// Marshal is the sketch as bytes: the precision, a flag, then the hashes
// or the registers.
func (s *Sketch) Marshal() []byte {
	if s.dense != nil {
		out := make([]byte, 2, 2+len(s.dense))
		out[0], out[1] = s.p, 1
		return append(out, s.dense...)
	}
	out := make([]byte, 2, 2+8*len(s.sparse))
	out[0] = s.p
	for _, h := range s.sparse {
		out = binary.BigEndian.AppendUint64(out, h)
	}
	return out
}

// Unmarshal reads what Marshal wrote. Empty input is an empty sketch of
// precision p.
func Unmarshal(b []byte, p uint8) (*Sketch, error) {
	if len(b) == 0 {
		return New(p), nil
	}
	if len(b) < 2 || b[0] < 4 || b[0] > 16 {
		return nil, errors.New("hll: not a sketch")
	}
	s := &Sketch{p: b[0]}
	body := b[2:]
	if b[1] == 1 {
		if len(body) != 1<<s.p {
			return nil, errors.New("hll: wrong number of registers")
		}
		s.dense = slices.Clone(body)
		return s, nil
	}
	if len(body)%8 != 0 {
		return nil, errors.New("hll: torn hash list")
	}
	s.sparse = make([]uint64, len(body)/8)
	for i := range s.sparse {
		s.sparse[i] = binary.BigEndian.Uint64(body[8*i:])
	}
	return s, nil
}
