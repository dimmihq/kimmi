package loadgen

import (
	"encoding/json"
	"fmt"
	"math"
	"math/rand/v2"
	"strings"

	"github.com/dimmihq/kimmi/internal/envelope"
)

const dayMs = 24 * 3600 * 1000

// Event is one event of a hit, as /i/v1/hit takes it.
type Event struct {
	T   int64           `json:"t"`
	K   string          `json:"k"`
	P   string          `json:"p,omitempty"`
	N   string          `json:"n,omitempty"`
	L   string          `json:"l,omitempty"`
	V   float64         `json:"v,omitempty"`
	X   int             `json:"x,omitempty"`
	Y   int             `json:"y,omitempty"`
	W   int             `json:"w,omitempty"`
	Num int             `json:"num,omitempty"`
	D   json.RawMessage `json:"d,omitempty"`
}

// seedVisitor is a person: everything about them follows from their seed,
// so the pool of people who may come back holds seeds only.
type seedVisitor struct {
	AnonymousID string
	Zone        seedZone
	Language    string
	Agent       seedAgent
	W, H        int
	Identity    *envelope.Identity // nil for the anonymous
}

// SeedFeedback is what a visitor wrote in the feedback box.
type SeedFeedback struct {
	At          int64
	Path, Text  string
	Email       string
	VisitID     string
	AnonymousID string
}

// Visit is one generated visit: who, when, from where, and its events in order.
type Visit struct {
	Index    int
	ID       string
	Visitor  seedVisitor
	Start    int64
	End      int64
	Channel  string
	Referrer string
	Landing  string // the first URL, with its campaign tags
	Release  string
	Events   []Event
	Feedback *SeedFeedback

	Returning bool // the visitor was seen before
	Live      bool // ends in the last two minutes
	Recorded  bool // also sent as a recording
	Bounce    bool
	// Reached is how far into the shop the visit went: 1 a product, 2 added
	// to the cart, 3 the cart, 4 the checkout, 5 bought.
	Reached              int
	Errors, Rages, Deads int

	seed uint64
}

// shift moves the whole visit in time.
func (v *Visit) shift(ms int64) {
	v.Start += ms
	v.End += ms
	for i := range v.Events {
		v.Events[i].T += ms
	}
	if v.Feedback != nil {
		v.Feedback.At += ms
	}
}

// seedPlan is what a history is generated from.
type seedPlan struct {
	Seed     uint64
	Days     int
	Visits   int
	Recorded int
	Now      int64 // Unix ms the history ends at
}

// generator hands out the visits of a plan one at a time, oldest day first.
// It keeps the visits still to come of the people it has made up (a seed
// each) and nothing else.
type generator struct {
	p      seedPlan
	rng    *rand.Rand
	days   []seedDay
	perDay []int
	live   int

	day, inDay, index int
	returns           [][]uint64 // per day: the visitors who come back on it

	recordLeft int
	weightSum  float64
}

// seedDay is a UTC calendar day of the period; the first and the last are
// cut by the period's ends.
type seedDay struct {
	from, to int64
	week     int64 // weeks since Monday 1969-12-29
	weekend  bool
	spike    bool
}

func newGenerator(p seedPlan) *generator {
	g := &generator{p: p, rng: rand.New(rand.NewPCG(p.Seed, 0x5eed)), days: planDays(p), recordLeft: min(p.Recorded, p.Visits)}
	g.live = min(liveVisits, p.Visits/10)
	g.perDay = spread(dayWeights(g.days), p.Visits-g.live)
	g.perDay[len(g.days)-1] += g.live
	g.returns = make([][]uint64, len(g.days))
	return g
}

// planDays cuts the period into calendar days and marks the campaign days:
// three weekdays, or two in a short period.
func planDays(p seedPlan) []seedDay {
	var days []seedDay
	for from := p.Now - int64(p.Days)*dayMs; from < p.Now; {
		n := from / dayMs // days since 1970-01-01, a Thursday
		weekday := (n + 4) % 7
		day := seedDay{from: from, to: min((n+1)*dayMs, p.Now), week: (n + 3) / 7, weekend: weekday == 0 || weekday == 6}
		days = append(days, day)
		from = day.to
	}
	at := spikeAt
	if p.Days < 21 {
		at = at[:2]
	}
	for _, f := range at {
		i := int(f * float64(len(days)))
		for i < len(days)-2 && days[i].weekend {
			i++
		}
		days[i].spike = p.Days >= 7
	}
	return days
}

// dayWeights is how busy each day of the period is: growth, the weekly
// rhythm, the campaign days, and less for a day that is cut short.
func dayWeights(days []seedDay) []float64 {
	out := make([]float64, len(days))
	for i, d := range days {
		w := 1 + growthOverPeriod*float64(i)/float64(max(len(days)-1, 1))
		if d.weekend {
			w *= weekendShare
		}
		if d.spike {
			w *= spikeBoost
		}
		out[i] = w * float64(d.to-d.from) / dayMs
	}
	return out
}

// spread shares n among the weights, exactly.
func spread(weights []float64, n int) []int {
	total := 0.0
	for _, w := range weights {
		total += w
	}
	out := make([]int, len(weights))
	acc, given := 0.0, 0
	for i, w := range weights {
		acc += w
		upto := int(math.Round(acc / total * float64(n)))
		out[i] = upto - given
		given = upto
	}
	return out
}

// next returns the next visit, or nil when the plan is done.
func (g *generator) next() *Visit {
	if g.index >= g.p.Visits {
		return nil
	}
	for g.inDay >= g.perDay[g.day] {
		g.returns[g.day] = nil
		g.day++
		g.inDay = 0
	}
	who, returning := g.who()
	person := newSeedVisitor(who)
	b := visitInput{plan: g.p, index: g.index, seed: g.rng.Uint64(), visitor: person, returning: returning,
		start: g.when(person.Zone), live: g.index >= g.p.Visits-g.live}
	// The extra visits of a campaign day come from its newsletter.
	b.campaign = g.days[g.day].spike && g.rng.Float64() < 1-1/spikeBoost
	v := buildVisit(b)
	v.Recorded = g.record(v)
	g.index++
	g.inDay++
	return v
}

// who picks the visitor: someone due back today, or a new person, whose
// later visits are planned at once.
func (g *generator) who() (seed uint64, returning bool) {
	if due := g.returns[g.day]; len(due) > 0 {
		g.returns[g.day] = due[:len(due)-1]
		return due[len(due)-1], true
	}
	seed = g.rng.Uint64()
	for weeks, p := range returnByWeek {
		if g.rng.Float64() >= p {
			continue
		}
		times := 1
		if g.rng.Float64() < returnTwice {
			times = 2
		}
		for range times {
			if day, ok := g.dayOfWeek(g.days[g.day].week + int64(weeks)); ok {
				g.returns[day] = append(g.returns[day], seed)
			}
		}
	}
	return seed, false
}

// dayOfWeek picks a day after today in the given calendar week, weekends
// less often. There is none when the week is over or past the period.
func (g *generator) dayOfWeek(week int64) (int, bool) {
	var weights [7]float64
	first, n := 0, 0
	for i := g.day + 1; i < len(g.days) && g.days[i].week <= week; i++ {
		if g.days[i].week < week {
			continue
		}
		if n == 0 {
			first = i
		}
		weights[n] = 1
		if g.days[i].weekend {
			weights[n] = weekendShare
		}
		n++
	}
	if n == 0 {
		return 0, false
	}
	return first + pickIndex(g.rng, weights[:n]), true
}

// when picks the moment of a visit inside the current day, following the
// visitor's local time.
func (g *generator) when(z seedZone) int64 {
	d := g.days[g.day]
	midnight := d.from / dayMs * dayMs
	var weights [24]float64
	for h := range weights {
		if from := midnight + int64(h)*3600_000; from+3600_000 <= d.from || from >= d.to {
			continue
		}
		weights[h] = hourCurve[((h*60+30+z.offsetMin)/60%24+24)%24]
	}
	at := midnight + int64(pickIndex(g.rng, weights[:]))*3600_000 + g.rng.Int64N(3600_000)
	return min(max(at, d.from), d.to-1)
}

// record decides whether the visit is also a recording. Visits with errors
// and rage clicks, and those deep in the funnel, are recorded more often;
// the chance follows what is left to hand out so the total comes out right.
func (g *generator) record(v *Visit) bool {
	if g.recordLeft <= 0 {
		return false
	}
	// The live visits at the very end are recorded, so the dashboard's live
	// view has something to show: their share is kept for them.
	left, free := g.p.Visits-g.live-g.index, g.recordLeft-g.live
	w := recordWeight(v)
	g.weightSum += w
	mean := g.weightSum / float64(g.index+1)
	if v.Live || free >= left || (free > 0 && g.rng.Float64() < w/mean*float64(free)/float64(left)) {
		g.recordLeft--
		return true
	}
	return false
}

// recordWeight is how much more often than a plain visit this one is recorded.
func recordWeight(v *Visit) float64 {
	w := 1.0
	if v.Bounce {
		w = 0.4
	}
	w *= [...]float64{1, 1.2, 1.8, 2.2, 2.6, 2}[v.Reached]
	if v.Errors > 0 {
		w *= 4
	}
	if v.Rages > 0 {
		w *= 4
	}
	if v.Deads > 0 {
		w *= 2
	}
	if v.Visitor.Identity != nil {
		w *= 3
	}
	return w
}

// newSeedVisitor derives a visitor from their seed.
func newSeedVisitor(seed uint64) seedVisitor {
	rng := rand.New(rand.NewPCG(seed, 0x76697369746f72))
	p := seedVisitor{AnonymousID: seedUUID(rng, 0)}
	p.Zone = pick(rng, seedZones, func(z seedZone) float64 { return z.weight })
	p.Language = p.Zone.language
	if !strings.HasPrefix(p.Language, "en") && rng.Float64() < 0.12 {
		p.Language = "en-US"
	}
	class := pickIndex(rng, classShare[:])
	p.Agent = pick(rng, seedAgents, func(a seedAgent) float64 {
		if a.class != class {
			return 0
		}
		return a.weight
	})
	size := seedViewports[class][rng.IntN(len(seedViewports[class]))]
	p.W, p.H = size[0], size[1]
	if rng.Float64() < identifiedShare {
		first, last := firstNames[rng.IntN(len(firstNames))], lastNames[rng.IntN(len(lastNames))]
		domain := personalDomains[rng.IntN(len(personalDomains))]
		if rng.Float64() < companyShare {
			domain = companyDomains[rng.IntN(len(companyDomains))]
		}
		p.Identity = &envelope.Identity{ID: fmt.Sprintf("u_%06x", rng.IntN(1<<24)), Name: first + " " + last,
			Email: strings.ToLower(first+"."+last) + "@" + domain}
	}
	return p
}

// seedUUID is a UUID from rng: version 7 shaped around ms when it is set,
// version 4 otherwise.
func seedUUID(rng *rand.Rand, ms int64) string {
	hi, lo := rng.Uint64(), rng.Uint64()
	version := uint64(4)
	if ms > 0 {
		hi = uint64(ms)<<16 | hi&0xffff
		version = 7
	}
	hi = hi&^0xf000 | version<<12
	lo = lo&^(3<<62) | 2<<62
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", hi>>32, hi>>16&0xffff, hi&0xffff, lo>>48, lo&0xffffffffffff)
}

// pickIndex picks an index by weight.
func pickIndex(rng *rand.Rand, weights []float64) int {
	total := 0.0
	for _, w := range weights {
		total += w
	}
	r := rng.Float64() * total
	for i, w := range weights {
		if r -= w; r < 0 {
			return i
		}
	}
	return len(weights) - 1
}

// pick picks an item by weight.
func pick[T any](rng *rand.Rand, items []T, weight func(T) float64) T {
	weights := make([]float64, len(items))
	for i, it := range items {
		weights[i] = weight(it)
	}
	return items[pickIndex(rng, weights)]
}

// visitInput is what one visit is built from.
type visitInput struct {
	plan      seedPlan
	index     int
	seed      uint64
	visitor   seedVisitor
	start     int64
	returning bool
	live      bool
	campaign  bool // from the spike days' newsletter
}

// buildVisit plays one visit through the shop. It depends on its input
// only, so a plan always gives the same visits.
func buildVisit(in visitInput) *Visit {
	rng := rand.New(rand.NewPCG(in.seed, uint64(in.index)))
	v := &Visit{Index: in.index, ID: seedUUID(rng, in.start), Visitor: in.visitor, Start: in.start,
		Returning: in.returning, Live: in.live, seed: in.seed}
	period := float64(int64(in.plan.Days) * dayMs)
	frac := 1 - float64(in.plan.Now-in.start)/period
	for _, r := range seedReleases {
		if frac >= r.from {
			v.Release = r.name
		}
	}

	src := pick(rng, seedSources, func(s seedSource) float64 { return s.weight })
	if in.campaign {
		src = emailSource
	}
	w := &walker{rng: rng, v: v, t: in.start, class: in.visitor.Agent.class, convert: src.convert, bounce: src.bounce,
		daysAgo: float64(in.plan.Now-in.start) / dayMs}
	if in.returning {
		w.convert *= returningConvert
	}
	product := -1
	path := "/"
	if rng.Float64() < landOnProduct || (src.channel == "Paid" && rng.Float64() < 0.3) {
		product = w.pickProduct(-1)
		path = productPath(product)
	}
	v.Channel, v.Referrer, v.Landing = src.channel, "", seedSite+path
	if len(src.referrers) > 0 {
		v.Referrer = src.referrers[rng.IntN(len(src.referrers))]
	}
	if len(src.utm) > 0 {
		query := src.utm[rng.IntN(len(src.utm))]
		if in.campaign {
			query = src.utm[0]
		}
		if src.clickID {
			query += fmt.Sprintf("&gclid=Cj0KCQ%010x", rng.Uint64()&0xffffffffff)
		}
		v.Landing += "?" + query
	}

	w.run(product)
	v.End, v.Bounce = w.t, bounced(v.Events)
	w.feedback()

	// Nothing happens after now: a visit that would run past it is moved
	// back, and a live one ends within the last two minutes.
	late := v.End - (in.plan.Now - 3000)
	if in.live {
		late = v.End - (in.plan.Now - 5000 - rng.Int64N(95_000))
	}
	if late > 0 || in.live {
		v.shift(-late)
	}
	return v
}

// bounced is the server's rule for a bounce: one page view, no click or
// tracked event, under 10 s engaged.
func bounced(events []Event) bool {
	pages, engaged := 0, 0.0
	for _, e := range events {
		switch e.K {
		case "page":
			pages++
		case "click", "track":
			return false
		case "leave":
			engaged += e.V
		}
	}
	return pages == 1 && engaged < 10_000
}

func productPath(i int) string { return "/products/" + seedProducts[i].id }

// pageTitle is the document title of a path.
func pageTitle(path string) string {
	switch path {
	case "/":
		return "Fernhill Goods"
	case "/cart":
		return "Your cart · Fernhill Goods"
	case "/checkout":
		return "Checkout · Fernhill Goods"
	case "/thanks":
		return "Thank you · Fernhill Goods"
	case "/login":
		return "Sign in · Fernhill Goods"
	}
	for _, p := range seedProducts {
		if path == "/products/"+p.id {
			return p.name + " · Fernhill Goods"
		}
	}
	return "Fernhill Goods"
}

// pageHeight is the full height of a path's page in pixels.
func pageHeight(path string) int {
	switch {
	case path == "/":
		return homeHeight
	case strings.HasPrefix(path, "/products/"):
		return otherHeight + 20
	case path == "/checkout":
		return otherHeight + 40
	}
	return otherHeight - 40
}

// walker plays a visitor through the shop, writing the visit's events.
type walker struct {
	rng     *rand.Rand
	v       *Visit
	t       int64 // the visit's clock
	class   int
	convert float64 // how much likelier than average this visit buys
	bounce  float64
	daysAgo float64
	views   int
}

func (w *walker) chance(p float64) bool { return w.rng.Float64() < p }

func (w *walker) reach(step int) { w.v.Reached = max(w.v.Reached, step) }

// logNormal draws around a median.
func (w *walker) logNormal(median, sigma float64) float64 {
	return median * math.Exp(sigma*w.rng.NormFloat64())
}

// engaged is how long someone looks at a page, in ms: about 20 seconds.
func (w *walker) engaged() float64 {
	return min(max(w.logNormal(20_000, 0.75), 1500), 600_000)
}

// pickProduct picks a product by popularity, other than not.
func (w *walker) pickProduct(not int) int {
	for {
		i := pickIndex(w.rng, productWeights)
		if i != not {
			return i
		}
	}
}

var productWeights = func() []float64 {
	out := make([]float64, len(seedProducts))
	for i, p := range seedProducts {
		out[i] = p.weight
	}
	return out
}()

// run is the whole visit, from the landing page (the home page, or a
// product when product is not negative).
func (w *walker) run(product int) {
	path, bounce := "/", bounceHome
	if product >= 0 {
		path, bounce = productPath(product), bounceProduct
	}
	if w.chance(bounce * w.bounce) {
		w.view(path, 1000+w.rng.Float64()*7500, w.scroll(path, true), true)
		return
	}
	if product < 0 {
		if !w.chance(homeToProduct) {
			w.wander()
			return
		}
		product = w.pickProduct(-1)
		w.home(product)
	}
	w.shop(product)
}

// wander is a visit that stays but opens no product.
func (w *walker) wander() {
	switch r := w.rng.Float64(); {
	case r < wanderLogin:
		w.view("/", w.engaged(), w.scroll("/", false), false, w.clicks("sign-in"))
		w.login()
	case r < wanderLogin+wanderCart:
		w.view("/", w.engaged(), w.scroll("/", false), false, w.clicks("cart"))
		w.view("/cart", 2000+w.rng.Float64()*6000, 100, false)
	default:
		w.view("/", max(w.engaged(), 11_000), w.scroll("/", false), false)
	}
}

// login is the sign-in page; most submit the form and land back home.
func (w *walker) login() {
	if !w.chance(0.7) {
		w.view("/login", w.engaged()/2, 100, false, w.clicks("field-name"))
		return
	}
	submit := append(w.clicks("login-submit"), track("$form", map[string]any{"form": "login", "action": "/login"}, 0))
	w.view("/login", w.engaged(), 100, false, w.clicks("field-name"), w.clicks("field-email"), submit)
	w.view("/", w.engaged()/2, w.scroll("/", false), false)
}

// home is a home page view that ends with a click on a product card.
func (w *walker) home(product int) {
	card := w.clickAt(cardSelector, seedProducts[product].name, cardSpot(w.class, product))
	w.view("/", w.engaged(), w.scroll("/", false), false, []Event{card})
}

// cardSpot is where the card of product i sits on the home page.
func cardSpot(class, i int) spot {
	g := cardGrid[class]
	return spot{g.columns[i%len(g.columns)], g.firstRow + g.step*float64(i/len(g.columns))}
}

// shop is the funnel from a first product page on: look at one or a few
// products, perhaps add one to the cart, open the cart, check out and buy.
func (w *walker) shop(product int) {
	adds := w.chance(min(productToAdd*w.convert, 0.9))
	toCart := adds && w.chance(addToCartPage)
	toCheckout := toCart && w.chance(cartToCheckout)
	buys := toCheckout && w.chance(min(checkoutToBuy*math.Pow(w.convert, 0.3), 0.95))

	looks := 1
	for looks < 4 && w.chance(anotherProduct) {
		looks++
	}
	for i := range looks {
		w.reach(1)
		if i == looks-1 {
			w.product(product, adds, toCart)
			break
		}
		w.product(product, false, false, w.clicks("back"))
		product = w.pickProduct(product)
		w.home(product)
	}
	if adds {
		w.reach(2)
	}
	if !toCart {
		return
	}
	w.reach(3)
	if !toCheckout {
		w.view("/cart", w.engaged(), 100, false)
		return
	}
	w.view("/cart", w.engaged()/2, 100, false, w.clicks("checkout"))
	w.reach(4)
	w.checkout(product, buys)
	if !buys {
		return
	}
	if w.chance(keepShopping) {
		w.view("/thanks", 2000+w.rng.Float64()*8000, 100, false, w.clicks("keep-shopping"))
		w.view("/", w.engaged()/2, w.scroll("/", false), false)
		return
	}
	w.view("/thanks", 2000+w.rng.Float64()*12_000, 100, false)
}

// product is a product page view with its friction: the dead "Compare"
// button, the stock check that fails, the picture that does not zoom.
func (w *walker) product(i int, adds, toCart bool, exit ...[]Event) {
	p := seedProducts[i]
	var groups [][]Event
	if w.chance(deadImage) {
		groups = append(groups, w.dead("image"))
	}
	if w.chance(checkStock) {
		status := 404
		if w.chance(0.3) {
			status = 500
		}
		failed := Event{K: "request", N: "GET shop.example/api/stock/" + p.id + ".json", Num: status, V: float64(60 + w.rng.IntN(600))}
		groups = append(groups, append(w.clicks("stock"), failed))
		if w.chance(rageStock) {
			groups = append(groups, w.rage("stock"))
		}
	}
	switch {
	case w.chance(rageCompare):
		groups = append(groups, w.rage("compare"))
	case w.chance(deadCompare):
		groups = append(groups, w.dead("compare"))
	}
	if w.chance(downloadClick) {
		file := downloadFiles[w.rng.IntN(len(downloadFiles))]
		groups = append(groups, append(w.clicks("download"), track("$download", map[string]any{"file": file}, 0)))
	}
	if adds {
		groups = append(groups, append(w.clicks("add"), track("add_to_cart", map[string]any{"product": p.id}, 0)))
	}
	if toCart {
		groups = append(groups, w.clicks("cart"))
	}
	scroll := 100
	if w.chance(0.15) {
		scroll = 55 + w.rng.IntN(45)
	}
	w.view(productPath(i), w.engaged(), scroll, false, append(groups, exit...)...)
}

// checkout is the checkout page: the form, sometimes a rage click on the
// card field, and for buyers the order, which can be slow.
func (w *walker) checkout(product int, buys bool) {
	var groups [][]Event
	fields := []string{"field-name", "field-email", "field-card"}
	if !buys {
		fields = fields[:w.rng.IntN(len(fields)+1)]
	}
	for _, f := range fields {
		groups = append(groups, w.clicks(f))
	}
	if len(fields) == 3 && w.chance(rageCardField) {
		groups = append(groups, w.rage("field-card"))
	}
	if buys {
		items := 1 + w.rng.IntN(3)
		value := min(max(seedProducts[product].price*float64(items)+float64(w.rng.IntN(40)), 20), 240)
		order := append(w.clicks("place-order"), track("$form", map[string]any{"form": "checkout", "action": "/checkout"}, 0))
		if w.chance(slowOrder) {
			order = append(order, Event{K: "request", N: "POST shop.example/api/orders", Num: 200, V: float64(3000 + w.rng.IntN(6000))})
		}
		order = append(order, track("purchase", map[string]any{"items": items, "value": value}, value))
		groups = append(groups, order)
		w.reach(5)
	}
	w.view("/checkout", w.engaged()*1.5, 100, false, groups...)
}

// scroll is the deepest scroll of a page view in percent. The home page
// is long, so its depths spread out; the others fit a screen or two.
func (w *walker) scroll(path string, bounce bool) int {
	if path != "/" {
		return 100
	}
	if bounce {
		return 30 + w.rng.IntN(35)
	}
	if w.chance(0.18) {
		return 100
	}
	return 30 + w.rng.IntN(71)
}

// track is a tracked event.
func track(name string, props map[string]any, value float64) Event {
	e := Event{K: "track", N: name, V: value}
	if props != nil {
		e.D, _ = json.Marshal(props)
	}
	return e
}

// clickAt is a heatmap click near a spot of the page.
func (w *walker) clickAt(selector, label string, s spot) Event {
	width := float64(w.v.Visitor.W)
	x := s.x*100 + w.rng.NormFloat64()*clickJitter/width*10000
	y := s.y + w.rng.NormFloat64()*clickJitter
	return Event{K: "click", N: selector, L: label, X: int(min(max(x, 0), 10000)), Y: int(max(y, 0)), W: w.v.Visitor.W}
}

// clicks is one click on a named element.
func (w *walker) clicks(name string) []Event {
	el := seedElements[name]
	return []Event{w.clickAt(el.selector, el.label, el.at[w.class])}
}

// rage is three to seven quick clicks on an element and the rage event.
func (w *walker) rage(name string) []Event {
	el := seedElements[name]
	n := 3 + w.rng.IntN(5)
	out := make([]Event, 0, n+1)
	for range n {
		out = append(out, w.clickAt(el.selector, el.label, el.at[w.class]))
	}
	w.v.Rages++
	return append(out, Event{K: "rage", N: el.selector, L: el.label, V: float64(n)})
}

// dead is a click that does nothing and the dead-click event.
func (w *walker) dead(name string) []Event {
	el := seedElements[name]
	w.v.Deads++
	return []Event{w.clickAt(el.selector, el.label, el.at[w.class]), {K: "dead", N: el.selector, L: el.label}}
}

// view plays one page view: the page event, what happens on the page
// (groups, in order: the last one is what leads away), the web vitals of a
// full load, and the leave. quiet is a view without a single click.
func (w *walker) view(path string, engaged float64, scroll int, quiet bool, groups ...[]Event) {
	if w.views > 0 {
		w.t += 40 + w.rng.Int64N(160)
	}
	began := w.t
	w.emit(path, Event{K: "page", L: pageTitle(path)})
	loaded := w.views == 0 || w.chance(vitalsOnRoute)
	w.views++

	ambient := w.ambient(path, quiet)
	if n := len(groups); n > 0 {
		groups = append(groups[:n-1:n-1], append(ambient, groups[n-1])...)
	} else {
		groups = ambient
	}
	wall := int64(engaged*(1+w.rng.Float64()*0.25)) + 300
	gap := float64(wall) / float64(len(groups)+1)
	for _, group := range groups {
		w.t += int64(gap * (0.6 + w.rng.Float64()*0.4))
		for _, e := range group {
			w.emit(path, e)
			w.t += 110 + w.rng.Int64N(260)
		}
	}
	w.t = max(w.t+200, began+wall)
	if loaded {
		w.vitals(path)
	}
	w.emit(path, Event{K: "leave", V: math.Round(min(engaged, float64(w.t-began))), Num: scroll, Y: pageHeight(path), W: w.v.Visitor.W})
}

func (w *walker) emit(path string, e Event) {
	e.T, e.P = w.t, path
	w.v.Events = append(w.v.Events, e)
}

// ambient is what can happen on any page view: an uncaught error, a click
// on nothing, a click on an outside link.
func (w *walker) ambient(path string, quiet bool) [][]Event {
	var groups [][]Event
	where := errorWhere{path: path, product: strings.HasPrefix(path, "/products/"), safari: w.v.Visitor.Agent.safari,
		daysAgo: w.daysAgo, release: w.v.Release}
	for i := range seedErrors {
		if w.chance(seedErrors[i].rate(where)) {
			groups = append(groups, []Event{w.failure(&seedErrors[i])})
			w.v.Errors++
		}
	}
	if quiet {
		return groups
	}
	if w.chance(strayClick) {
		at := spot{5 + w.rng.Float64()*90, w.rng.Float64() * float64(pageHeight(path))}
		groups = append(groups, []Event{w.clickAt("div.shell > main.main", "", at)})
	}
	if path == "/" && w.chance(headerClick) {
		groups = append(groups, w.clicks([]string{"brand", "shop"}[w.rng.IntN(2)]))
	}
	if w.chance(outboundClick) {
		link := outboundLinks[w.rng.IntN(len(outboundLinks))]
		groups = append(groups, append(w.footer(path, "outbound"), track("$outbound", map[string]any{"url": link}, 0)))
	}
	if w.chance(emailClick) {
		groups = append(groups, append(w.footer(path, "mailto"), track("$email", nil, 0)))
	}
	return groups
}

// footer is a click on a footer element, which sits at the bottom of the
// page whatever its height.
func (w *walker) footer(path, name string) []Event {
	el := seedElements[name]
	at := el.at[w.class]
	if path == "/" {
		at.y += homeHeight - otherHeight
	}
	return []Event{w.clickAt(el.selector, el.label, at)}
}

// failure is an uncaught error with its stack.
func (w *walker) failure(kind *seedError) Event {
	message := kind.message
	if len(kind.nums) > 0 {
		message = fmt.Sprintf(message, kind.nums[w.rng.IntN(len(kind.nums))])
	}
	source := seedSite + "/assets/" + kind.file
	var stack strings.Builder
	stack.WriteString(message)
	for _, fn := range kind.frames {
		fmt.Fprintf(&stack, "\n    at %s (%s:%d:%d)", fn, source, 1+w.rng.IntN(40), 100+w.rng.IntN(48_000))
	}
	d, _ := json.Marshal(map[string]string{"source": source, "stack": stack.String()})
	return Event{K: "error", L: message, D: d}
}

// vitals is the web vitals of one page load: slower on phones and on the
// home page, with a slow tail.
func (w *walker) vitals(path string) {
	factor := [3]float64{classDesktop: 1, classTablet: vitalTablet, classMobile: vitalMobile}[w.class]
	if path == "/" {
		factor *= vitalHome
	}
	if w.chance(vitalSlowTail) {
		factor *= 3
	}
	for _, vital := range seedVitals {
		if !w.chance(vital.share) {
			continue
		}
		value := math.Round(w.logNormal(vital.median*factor, vital.sigma))
		if vital.name == "cls" {
			value = math.Round(min(w.logNormal(vital.median*math.Sqrt(factor), vital.sigma), 0.4)*1000) / 1000
		}
		w.emit(path, Event{K: "vital", N: vital.name, V: value})
	}
}

// feedback lets a few visitors write something from a page they saw.
func (w *walker) feedback() {
	if !w.chance(feedbackShare) {
		return
	}
	v := w.v
	on := v.Events[w.rng.IntN(len(v.Events))]
	f := &SeedFeedback{At: min(on.T+2000, v.End), Path: on.P, Text: feedbackTexts[w.rng.IntN(len(feedbackTexts))],
		VisitID: v.ID, AnonymousID: v.Visitor.AnonymousID}
	if w.chance(feedbackEmails) {
		f.Email = strings.ToLower(firstNames[w.rng.IntN(len(firstNames))]+"."+lastNames[w.rng.IntN(len(lastNames))]) + "@" +
			personalDomains[w.rng.IntN(len(personalDomains))]
		if v.Visitor.Identity != nil {
			f.Email = v.Visitor.Identity.Email
		}
	}
	v.Feedback = f
}

// seedHit is the body of a POST /i/v1/hit, with the `at` the server
// honours under KIMMI_TEST_HOOKS.
type seedHit struct {
	V           int               `json:"v"`
	VisitID     string            `json:"visitId"`
	AnonymousID string            `json:"anonymousId"`
	StartedAt   int64             `json:"startedAt"`
	URL         string            `json:"url"`
	Landing     string            `json:"landing"`
	Referrer    string            `json:"referrer"`
	Viewport    envelope.Viewport `json:"viewport"`
	Language    string            `json:"language"`
	Timezone    string            `json:"timezone"`
	Release     string            `json:"release"`
	Events      []Event           `json:"events"`
	At          int64             `json:"at"`
}

// maxHitEvents is the most events put in one hit (the server takes 200).
const maxHitEvents = 80

// hits cuts the visit into the hits a browser would have sent, in order.
func (v *Visit) hits() []seedHit {
	var out []seedHit
	for from := 0; from < len(v.Events); from += maxHitEvents {
		events := v.Events[from:min(from+maxHitEvents, len(v.Events))]
		last := events[len(events)-1]
		out = append(out, seedHit{V: 1, VisitID: v.ID, AnonymousID: v.Visitor.AnonymousID, StartedAt: v.Start,
			URL: seedSite + last.P, Landing: v.Landing, Referrer: v.Referrer,
			Viewport: envelope.Viewport{W: v.Visitor.W, H: v.Visitor.H}, Language: v.Visitor.Language,
			Timezone: v.Visitor.Zone.name, Release: v.Release, Events: events, At: last.T})
	}
	return out
}
