package loadgen

import (
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"strconv"
	"strings"
)

// The synthetic page: a shop's product listing, built as an rrweb
// serialized DOM tree of roughly snapshotTarget bytes of JSON.
const snapshotTarget = 40 << 10

type node struct {
	Type     int     `json:"type"`
	ID       int     `json:"id"`
	Name     string  `json:"name,omitempty"`
	PublicID *string `json:"publicId,omitempty"`
	SystemID *string `json:"systemId,omitempty"`
	TagName  string  `json:"tagName,omitempty"`
	// Pointers, so an element sends {} and [] when empty, as rrweb's
	// replayer requires, and text nodes send neither.
	Attributes  *map[string]string `json:"attributes,omitempty"`
	ChildNodes  *[]*node           `json:"childNodes,omitempty"`
	TextContent *string            `json:"textContent,omitempty"`
}

type page struct {
	snapshot     []byte // JSON of the document node
	interactives []int  // ids of buttons and links, for clicks
	inputs       []int  // ids of text inputs
	maxID        int
}

func buildPage() page {
	var p page
	id := 0
	next := func() int { id++; return id }
	el := func(tag string, attrs map[string]string, kids ...*node) *node {
		if attrs == nil {
			attrs = map[string]string{}
		}
		if kids == nil {
			kids = []*node{}
		}
		return &node{Type: 2, ID: next(), TagName: tag, Attributes: &attrs, ChildNodes: &kids}
	}
	text := func(s string) *node { return &node{Type: 3, ID: next(), TextContent: &s} }
	empty := ""

	doctype := &node{Type: 1, ID: next(), Name: "html", PublicID: &empty, SystemID: &empty}
	head := el("head", nil,
		el("meta", map[string]string{"charset": "utf-8"}),
		el("meta", map[string]string{"name": "viewport", "content": "width=device-width, initial-scale=1"}),
		el("title", nil, text("Acme Outfitters · New arrivals")),
		el("style", nil, text(strings.Repeat(".card{display:flex;flex-direction:column;gap:8px;padding:16px;border-radius:12px;border:1px solid #e5e7eb}", 12))),
	)
	var nav []*node
	for _, label := range []string{"New", "Women", "Men", "Kids", "Sale", "Stores"} {
		a := el("a", map[string]string{"href": "/" + strings.ToLower(label), "class": "nav-link"}, text(label))
		p.interactives = append(p.interactives, a.ID)
		nav = append(nav, a)
	}
	search := el("input", map[string]string{"type": "search", "name": "q", "placeholder": "Search products", "class": "search"})
	p.inputs = append(p.inputs, search.ID)
	header := el("header", map[string]string{"class": "site-header"}, el("nav", map[string]string{"class": "nav"}, nav...), search)

	grid := el("section", map[string]string{"class": "grid", "aria-label": "Products"})
	main := el("main", map[string]string{"id": "content"}, el("h1", nil, text("New arrivals")), grid)
	footer := el("footer", map[string]string{"class": "site-footer"}, el("p", nil, text("© Acme Outfitters")))
	body := el("body", map[string]string{"class": "theme-light"}, header, main, footer)
	html := el("html", map[string]string{"lang": "en"}, head, body)
	doc := &node{Type: 0, ID: next(), ChildNodes: &[]*node{doctype, html}}

	for i := 0; ; i++ {
		btn := el("button", map[string]string{"type": "button", "class": "add-to-cart", "data-sku": fmt.Sprintf("SKU-%05d", 1000+i)}, text("Add to cart"))
		p.interactives = append(p.interactives, btn.ID)
		card := el("article", map[string]string{"class": "card", "data-product": strconv.Itoa(i)},
			el("img", map[string]string{"src": fmt.Sprintf("/images/products/%d.webp", i), "alt": "Product photo", "width": "320", "height": "400", "loading": "lazy"}),
			el("h3", map[string]string{"class": "card-title"}, text(fmt.Sprintf("Trail runner jacket, colour %d", i))),
			el("p", map[string]string{"class": "card-price"}, text(fmt.Sprintf("£%d.00", 49+i%70))),
			el("p", map[string]string{"class": "card-description"}, text("Lightweight, water resistant and packable. Taped seams, adjustable hood and two zipped pockets.")),
			btn,
		)
		*grid.ChildNodes = append(*grid.ChildNodes, card)
		if i%8 == 7 {
			b, _ := json.Marshal(doc)
			if len(b) >= snapshotTarget {
				p.snapshot = b
				break
			}
		}
	}
	p.maxID = id
	return p
}

var userAgents = []string{
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.2903.70",
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
	"Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0",
	"Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
	"Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.81 Mobile Safari/537.36",
	"Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
}

var timezones = []string{"Africa/Lagos", "Europe/London", "America/New_York", "Europe/Berlin", "Asia/Kolkata",
	"America/Sao_Paulo", "Asia/Tokyo", "Australia/Sydney", "America/Los_Angeles", "Europe/Paris"}

var paths = []string{"/", "/new", "/women", "/men", "/sale", "/product/trail-runner", "/cart", "/checkout"}

// eventList builds a JSON array of events.
type eventList struct {
	b strings.Builder
	n int
}

func (l *eventList) add(format string, args ...any) {
	if l.n > 0 {
		l.b.WriteByte(',')
	}
	fmt.Fprintf(&l.b, format, args...)
	l.n++
}

func (l *eventList) json() []byte { return []byte("[" + l.b.String() + "]") }

// eventGen writes the rrweb events of one synthetic visit. Timestamps never
// pass limit (the wall clock when the batch is built), as with a real browser.
type eventGen struct {
	rng   *rand.Rand
	page  *page
	ts    int64
	limit int64
	x, y  int
}

// tally is what a batch's metadata reports about its events.
type tally struct {
	clicks, keypresses int
}

func (g *eventGen) tick(maxMs int) int64 {
	g.ts = min(g.ts+int64(1+g.rng.IntN(maxMs)), max(g.limit, g.ts))
	return g.ts
}

// opening is the first batch's head: Meta, FullSnapshot and a navigate event.
func (g *eventGen) opening(l *eventList, href, path string, w, h int) {
	l.add(`{"type":4,"data":{"href":%q,"width":%d,"height":%d},"timestamp":%d}`, href, w, h, g.tick(5))
	l.add(`{"type":2,"data":{"node":%s,"initialOffset":{"left":0,"top":0}},"timestamp":%d}`, g.page.snapshot, g.tick(20))
	l.add(`{"type":5,"data":{"tag":"navigate","payload":{"href":%q,"path":%q,"title":"Acme Outfitters"}},"timestamp":%d}`, href, path, g.tick(5))
}

// activity appends n incremental events in the mix a real visit has: mostly
// mouse moves, then scrolls, clicks and typing.
func (g *eventGen) activity(l *eventList, n int, t *tally) {
	for range n {
		switch r := g.rng.IntN(100); {
		case r < 60:
			var pos strings.Builder
			for j := range 4 {
				g.x = max(0, min(1440, g.x+g.rng.IntN(81)-40))
				g.y = max(0, min(900, g.y+g.rng.IntN(61)-30))
				if j > 0 {
					pos.WriteByte(',')
				}
				fmt.Fprintf(&pos, `{"x":%d,"y":%d,"id":%d,"timeOffset":%d}`, g.x, g.y, 1+g.rng.IntN(g.page.maxID), -50*(3-j))
			}
			l.add(`{"type":3,"data":{"source":1,"positions":[%s]},"timestamp":%d}`, pos.String(), g.tick(200))
		case r < 80:
			l.add(`{"type":3,"data":{"source":3,"id":1,"x":0,"y":%d},"timestamp":%d}`, g.rng.IntN(6000), g.tick(300))
		case r < 90:
			id := g.page.interactives[g.rng.IntN(len(g.page.interactives))]
			l.add(`{"type":3,"data":{"source":2,"type":2,"id":%d,"x":%d,"y":%d,"pointerType":0},"timestamp":%d}`, id, g.x, g.y, g.tick(400))
			t.clicks++
		default:
			id := g.page.inputs[g.rng.IntN(len(g.page.inputs))]
			word := []string{"jacket", "running shoes", "waterproof", "gift card"}[g.rng.IntN(4)]
			l.add(`{"type":3,"data":{"source":5,"text":%q,"isChecked":false,"id":%d},"timestamp":%d}`, word, id, g.tick(500))
			t.keypresses += len(word)
		}
	}
}

// navigate appends an SPA route change.
func (g *eventGen) navigate(l *eventList, href, path string) {
	l.add(`{"type":5,"data":{"tag":"navigate","payload":{"href":%q,"path":%q,"title":"Acme Outfitters"}},"timestamp":%d}`, href, path, g.tick(50))
}
