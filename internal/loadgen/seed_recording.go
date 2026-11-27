package loadgen

import (
	"encoding/json"
	"math/rand/v2"
	"slices"
	"strings"

	"github.com/dimmihq/kimmi/internal/envelope"
)

// seedBatch is one batch of a recording before it is compressed.
type seedBatch struct {
	Meta   envelope.Meta
	Events []byte // a JSON array of rrweb events
}

// replayer turns a visit's hit events into the rrweb events of its
// recording, on top of loadgen's event generator.
type replayer struct {
	g    *eventGen
	v    *Visit
	l    *eventList
	meta *envelope.Meta
}

// recording builds the batches of a visit's recording: two to six, the
// first with the page snapshot, each with the custom events (navigate,
// error, rage-click, dead-click, track, network) of its share of the visit
// so the player's timeline shows them, and counts that match the hits.
func recording(v *Visit, pg *page) []seedBatch {
	rng := rand.New(rand.NewPCG(v.seed, 0x7265636f7264))
	person := v.Visitor
	g := &eventGen{rng: rng, page: pg, ts: v.Start - 1, x: person.W / 2, y: person.H / 2}
	base := envelope.Meta{V: 1, SessionID: v.ID, WindowID: seedUUID(rng, 0), AnonymousID: person.AnonymousID,
		Identity: person.Identity, StartedAt: v.Start, Referrer: v.Referrer,
		Viewport: envelope.Viewport{W: person.W, H: person.H}, Language: person.Language,
		Timezone: person.Zone.name, Release: v.Release}

	n := 2 + rng.IntN(5)
	span := max(v.End-v.Start, int64(n))
	path := v.Events[0].P
	batches := make([]seedBatch, 0, n)
	next, first := 0, v.Start
	for seq := range n {
		end := v.Start + span*int64(seq+1)/int64(n)
		if seq == n-1 {
			end = max(v.End, end)
		}
		var l eventList
		meta := base
		meta.Seq, meta.FirstTs, meta.Paths = int64(seq), first, []string{}
		g.limit = end
		r := replayer{g: g, v: v, l: &l, meta: &meta}
		if seq == 0 {
			g.opening(&l, seedSite+path, path, person.W, person.H)
			if id := person.Identity; id != nil {
				r.custom(g.ts, "identify", map[string]any{"id": id.ID, "email": id.Email, "name": id.Name})
			}
			meta.Counts.Pageviews, meta.Paths = 1, []string{path}
			next = 1 // the opening was the first page view
		}
		for ; next < len(v.Events) && v.Events[next].T <= end; next++ {
			r.replay(v.Events[next])
			path = v.Events[next].P
		}
		r.move(end)
		meta.LastTs, meta.URL, meta.Path, meta.Counts.Events = max(g.ts, first), seedSite+path, path, l.n
		batches = append(batches, seedBatch{Meta: meta, Events: l.json()})
		first = meta.LastTs
	}
	return batches
}

// at moves the clock to ts, never backwards.
func (r *replayer) at(ts int64) int64 {
	r.g.ts = max(r.g.ts, ts)
	return r.g.ts
}

// custom appends an rrweb custom event.
func (r *replayer) custom(ts int64, tag string, payload any) {
	b, _ := json.Marshal(payload)
	r.l.add(`{"type":5,"data":{"tag":%q,"payload":%s},"timestamp":%d}`, tag, b, r.at(ts))
}

// move appends a pointer move.
func (r *replayer) move(ts int64) {
	g := r.g
	g.x = max(0, min(r.v.Visitor.W, g.x+g.rng.IntN(161)-80))
	g.y = max(0, min(r.v.Visitor.H, g.y+g.rng.IntN(121)-60))
	r.l.add(`{"type":3,"data":{"source":1,"positions":[{"x":%d,"y":%d,"id":%d,"timeOffset":0}]},"timestamp":%d}`,
		g.x, g.y, 1+g.rng.IntN(g.page.maxID), r.at(ts))
}

// replay appends what one hit event looked like in the recording and
// counts it in the batch's metadata.
func (r *replayer) replay(e Event) {
	g, c := r.g, &r.meta.Counts
	switch e.K {
	case "page":
		r.custom(e.T, "navigate", map[string]string{"href": seedSite + e.P, "path": e.P, "title": e.L})
		c.Pageviews++
		if !slices.Contains(r.meta.Paths, e.P) {
			r.meta.Paths = append(r.meta.Paths, e.P)
		}
	case "leave":
		r.l.add(`{"type":3,"data":{"source":3,"id":1,"x":0,"y":%d},"timestamp":%d}`, e.Y*e.Num/100, r.at(e.T-50))
		c.ActiveMs += int64(e.V)
	case "click":
		r.move(e.T - 250)
		g.x, g.y = e.X*r.v.Visitor.W/10000, min(e.Y, r.v.Visitor.H-1)
		r.l.add(`{"type":3,"data":{"source":2,"type":2,"id":%d,"x":%d,"y":%d,"pointerType":0},"timestamp":%d}`,
			g.page.interactives[g.rng.IntN(len(g.page.interactives))], g.x, g.y, r.at(e.T))
		c.Clicks++
		if strings.HasSuffix(e.N, "input") || strings.Contains(e.N, "input.") {
			r.l.add(`{"type":3,"data":{"source":5,"text":"••••••••","isChecked":false,"id":%d},"timestamp":%d}`,
				g.page.inputs[0], r.at(e.T+900))
			c.Keypresses += 8 + g.rng.IntN(20)
		}
	case "rage":
		r.custom(e.T, "rage-click", map[string]any{"selector": e.N, "text": e.L, "count": int(e.V)})
		c.RageClicks++
	case "dead":
		r.custom(e.T, "dead-click", map[string]string{"selector": e.N, "text": e.L})
		c.DeadClicks++
	case "error":
		var d struct{ Source, Stack string }
		_ = json.Unmarshal(e.D, &d)
		r.custom(e.T, "error", map[string]string{"message": e.L, "source": d.Source, "stack": d.Stack})
		c.Errors++
	case "track":
		props := e.D
		if props == nil {
			props = json.RawMessage("{}")
		}
		r.custom(e.T, "track", map[string]any{"name": e.N, "props": props})
	case "request":
		method, url, _ := strings.Cut(e.N, " ")
		r.custom(e.T, "network", map[string]any{"method": method, "url": "https://" + url, "status": e.Num,
			"ms": int(e.V), "size": 120 + g.rng.IntN(900), "kind": "fetch"})
	}
}
