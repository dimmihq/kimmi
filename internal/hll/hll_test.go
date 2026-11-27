package hll

import (
	"fmt"
	"math"
	"testing"
)

func fill(s *Sketch, from, to int) {
	for i := from; i < to; i++ {
		s.Add(Hash(fmt.Sprintf("visitor-%d", i)))
	}
}

func TestExactWhileSmallThenWithinTheStatedError(t *testing.T) {
	for _, p := range []uint8{10, 14} {
		s := New(p)
		fill(s, 0, s.limit())
		fill(s, 0, s.limit()) // seen twice counts once
		if got := s.Count(); got != s.limit() {
			t.Fatalf("p=%d: %d values counted as %d: small sets are exact", p, s.limit(), got)
		}
		for _, n := range []int{1000, 20_000, 300_000, 2_000_000} {
			s := New(p)
			fill(s, 0, n)
			allowed := 4 * 1.04 / math.Sqrt(float64(uint64(1)<<p)) // four standard errors
			if off := math.Abs(float64(s.Count()-n)) / float64(n); off > allowed {
				t.Errorf("p=%d n=%d: counted %d, off by %.2f%% (allowed %.2f%%)", p, n, s.Count(), off*100, allowed*100)
			}
		}
	}
}

func TestMergeEqualsAddingEverythingToOne(t *testing.T) {
	for _, sizes := range [][2]int{{50, 60}, {50, 5000}, {5000, 50}, {40_000, 70_000}} {
		a, b, both := New(11), New(11), New(11)
		fill(a, 0, sizes[0])
		fill(b, sizes[0]/2, sizes[0]/2+sizes[1]) // overlaps a
		fill(both, 0, sizes[0])
		fill(both, sizes[0]/2, sizes[0]/2+sizes[1])
		a.Merge(b)
		if a.Count() != both.Count() {
			t.Errorf("%v: merged %d, together %d", sizes, a.Count(), both.Count())
		}
	}
	a := New(11)
	a.Merge(nil)
	a.Merge(New(12)) // another precision is ignored, not mixed in
	if a.Count() != 0 {
		t.Fatal("merging nothing counted something")
	}
}

func TestMarshalRoundTrip(t *testing.T) {
	for _, n := range []int{0, 1, 200, 50_000} {
		s := New(11)
		fill(s, 0, n)
		back, err := Unmarshal(s.Marshal(), 11)
		if err != nil {
			t.Fatal(err)
		}
		if back.Count() != s.Count() {
			t.Errorf("n=%d: %d after a round trip, %d before", n, back.Count(), s.Count())
		}
		fill(back, n, n+10)
		fill(s, n, n+10)
		if back.Count() != s.Count() {
			t.Errorf("n=%d: a sketch read back must keep counting the same way", n)
		}
	}
	if s, err := Unmarshal(nil, 11); err != nil || s.Count() != 0 {
		t.Fatal("empty bytes are an empty sketch")
	}
	for _, bad := range [][]byte{{3}, {11, 0, 1, 2}, {11, 1, 0}, {99, 0}} {
		if _, err := Unmarshal(bad, 11); err == nil {
			t.Errorf("%v was read as a sketch", bad)
		}
	}
	dense := New(11)
	fill(dense, 0, 10_000)
	if n := len(dense.Marshal()); n != 2+2048 {
		t.Fatalf("a dense sketch of precision 11 is %d bytes, want 2050", n)
	}
}

// Adding must not get slower per value as the sketch fills: ten times the
// values in well under a hundred times the time.
func TestAddScalesLinearly(t *testing.T) {
	cost := func(n int) float64 {
		res := testing.Benchmark(func(b *testing.B) {
			for range b.N {
				s := New(14)
				fill(s, 0, n)
			}
		})
		return float64(res.NsPerOp())
	}
	small, large := cost(20_000), cost(200_000)
	if large > small*40 {
		t.Fatalf("200,000 adds took %.0fx as long as 20,000", large/small)
	}
}
