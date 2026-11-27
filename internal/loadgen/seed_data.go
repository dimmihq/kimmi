package loadgen

// The tables behind `kimmi seed`: who visits the imitated shop
// (examples/react-spa), from where, on what, and what they do there.
// Weights are relative within a table unless a comment says otherwise.

const seedSite = "https://shop.example"

// How visits spread over the period.
const (
	growthOverPeriod = 1.15 // the last day has 1+this times the visits of the first
	weekendShare     = 0.55 // a Saturday or Sunday against a weekday
	spikeBoost       = 2.4  // a campaign day against a normal one
	liveVisits       = 6    // visits that end in the last two minutes
)

// spikeAt places the campaign days, as fractions of the period.
var spikeAt = []float64{0.36, 0.63, 0.86}

// hourCurve is how busy each local hour is: quiet at night, a peak late in
// the morning and another in the evening.
var hourCurve = [24]float64{0.22, 0.14, 0.09, 0.07, 0.07, 0.11, 0.25, 0.5, 0.8, 1.1, 1.35, 1.4,
	1.2, 1.1, 1.0, 0.95, 0.95, 1.0, 1.1, 1.25, 1.4, 1.3, 0.9, 0.5}

// returnByWeek is the chance that a new visitor comes back later in the
// week of their first visit, one week later, two weeks later and so on: the
// weekly cohort grid reads 100%, 25%, 15%... and about 35% of visits are by
// someone seen before.
var returnByWeek = []float64{0.07, 0.25, 0.15, 0.09, 0.06, 0.04, 0.03, 0.02, 0.01}

// returnTwice is the share of those weeks with two visits.
const returnTwice = 0.12

// seedZone is a place visitors come from. Offsets are fixed (no daylight
// saving), which is enough for a believable daily curve.
type seedZone struct {
	name      string // must exist in internal/geo
	offsetMin int
	language  string
	weight    float64
}

var seedZones = []seedZone{
	{"America/New_York", -300, "en-US", 15}, {"America/Chicago", -360, "en-US", 8},
	{"America/Los_Angeles", -480, "en-US", 10}, {"America/Denver", -420, "en-US", 3},
	{"America/Toronto", -300, "en-CA", 3.5}, {"America/Vancouver", -480, "en-CA", 1.5},
	{"Europe/London", 0, "en-GB", 11}, {"Europe/Dublin", 0, "en-IE", 1.5},
	{"Europe/Berlin", 60, "de-DE", 6}, {"Europe/Paris", 60, "fr-FR", 5},
	{"Europe/Amsterdam", 60, "nl-NL", 3}, {"Europe/Madrid", 60, "es-ES", 2.5},
	{"Europe/Rome", 60, "it-IT", 2}, {"Europe/Stockholm", 60, "sv-SE", 1.5},
	{"Europe/Warsaw", 60, "pl-PL", 1.5}, {"Europe/Lisbon", 0, "pt-PT", 0.8},
	{"Europe/Zurich", 60, "de-CH", 0.8}, {"Europe/Istanbul", 180, "tr-TR", 0.8},
	{"Africa/Lagos", 60, "en-NG", 2.2}, {"Africa/Nairobi", 180, "en-KE", 1.2},
	{"Africa/Johannesburg", 120, "en-ZA", 1}, {"Africa/Cairo", 120, "ar-EG", 0.5},
	{"America/Sao_Paulo", -180, "pt-BR", 2.5}, {"America/Mexico_City", -360, "es-MX", 1.5},
	{"America/Argentina/Buenos_Aires", -180, "es-AR", 0.8}, {"America/Bogota", -300, "es-CO", 0.5},
	{"Asia/Kolkata", 330, "en-IN", 3.5}, {"Asia/Dubai", 240, "en-AE", 0.7},
	{"Asia/Singapore", 480, "en-SG", 1.2}, {"Asia/Tokyo", 540, "ja-JP", 2},
	{"Asia/Seoul", 540, "ko-KR", 0.8}, {"Asia/Jakarta", 420, "id-ID", 0.6},
	{"Australia/Sydney", 600, "en-AU", 2.5}, {"Australia/Melbourne", 600, "en-AU", 1},
	{"Pacific/Auckland", 720, "en-NZ", 0.6},
}

// Device classes, and the share of visitors on each.
const (
	classDesktop = iota
	classTablet
	classMobile
)

var classShare = [3]float64{classDesktop: 58, classTablet: 6, classMobile: 36}

type seedAgent struct {
	class  int
	safari bool // the browser reads as Safari
	weight float64
	ua     string
}

// seedAgents parse in internal/useragent to the class they are listed under.
var seedAgents = []seedAgent{
	{classDesktop, false, 22, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"},
	{classDesktop, false, 11, "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"},
	{classDesktop, true, 9, "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15"},
	{classDesktop, false, 6, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.2903.70"},
	{classDesktop, false, 4, "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0"},
	{classDesktop, false, 2, "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0"},
	{classDesktop, false, 1.5, "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0"},
	{classDesktop, false, 2.5, "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"},
	{classMobile, true, 18, "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1"},
	{classMobile, false, 13, "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.81 Mobile Safari/537.36"},
	{classMobile, false, 2.5, "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1"},
	{classMobile, false, 1.5, "Mozilla/5.0 (Android 14; Mobile; rv:133.0) Gecko/133.0 Firefox/133.0"},
	{classMobile, false, 1, "Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.81 Mobile Safari/537.36 EdgA/131.0.2903.87"},
	{classTablet, true, 4.5, "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"},
	{classTablet, false, 1.5, "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.81 Safari/537.36"},
}

// seedViewports are the window sizes of each class.
var seedViewports = [3][][2]int{
	classDesktop: {{1280, 720}, {1366, 768}, {1440, 900}, {1536, 864}, {1680, 1050}, {1920, 1080}},
	classTablet:  {{768, 1024}, {810, 1080}, {820, 1180}, {834, 1194}, {1000, 700}},
	classMobile:  {{360, 800}, {375, 812}, {390, 844}, {393, 852}, {412, 915}, {414, 896}, {430, 932}},
}

// Identified visitors.
const (
	identifiedShare = 0.08 // of visitors
	companyShare    = 0.60 // of identified visitors, the rest use personal mail
)

var firstNames = []string{"Ada", "Tunde", "Maya", "Jonas", "Chiara", "Kenji", "Amara", "Lucas", "Priya", "Sofia",
	"Noah", "Ines", "Olu", "Hannah", "Mateo", "Zainab", "Felix", "Yuki", "Wanjiru", "Elena", "Marcus", "Aisha",
	"Pieter", "Camille", "Diego", "Freya", "Rahul", "Nia", "Oscar", "Leila", "Tomasz", "Grace", "Hiro", "Bianca",
	"Samuel", "Ngozi", "Emil", "Carla", "Arjun", "Lotte"}

var lastNames = []string{"Okafor", "Lindqvist", "Marchetti", "Tanaka", "Adeyemi", "Schneider", "Dubois", "Sharma",
	"Costa", "Kowalski", "Mwangi", "Hughes", "Jansen", "Ramirez", "Fischer", "Nakamura", "Silva", "Bello", "Novak",
	"Moreau", "Iyer", "Campbell", "Eriksson", "Rossi", "Kamau", "Bauer", "Pereira", "Walsh", "Sato", "Mensah",
	"Petrov", "Vargas", "Olsen", "Nwosu", "Keller", "Patel", "Lambert", "Ortiz", "Kim", "Haddad"}

// companyDomains are invented, on a reserved top-level domain.
var companyDomains = []string{"northwind.example", "larkspur.example", "tidewater.example", "bluepeak.example",
	"harborline.example", "fennelandco.example", "quillworks.example", "brightloom.example", "cedarpoint.example",
	"mossbank.example", "ironbridge.example", "saltmarsh.example", "copperfield.example", "hollowayhq.example",
	"pinecrest.example", "atlasgrove.example", "wrenhouse.example", "kestrel-labs.example", "fieldnotes.example",
	"oakhaven.example", "lumenary.example", "stonebrook.example", "marlowe-studio.example", "greyfriars.example",
	"sundial.example", "thornbury.example", "elmwoodgroup.example", "riverbend.example", "halcyonworks.example",
	"tessellate.example", "birchline.example", "moorgate.example", "cobaltbay.example", "willowmere.example",
	"anchorpoint.example", "juniperhill.example", "redfernpartners.example", "ashgrove.example", "calderstone.example",
	"westmarch.example"}

var personalDomains = []string{"gmail.com", "gmail.com", "gmail.com", "outlook.com", "yahoo.com", "hotmail.com"}

// seedProduct is an item of the shop: the six of the example and two more
// to fill its four-column grid. Popularity is skewed.
type seedProduct struct {
	id, name string
	price    float64
	weight   float64
}

var seedProducts = []seedProduct{
	{"linen-throw", "Linen throw", 89, 30}, {"oak-tray", "Oak serving tray", 54, 12},
	{"stoneware-mug", "Stoneware mug", 24, 22}, {"wool-slippers", "Wool slippers", 62, 14},
	{"brass-lamp", "Brass desk lamp", 148, 8}, {"canvas-tote", "Waxed canvas tote", 45, 9},
	{"ceramic-planter", "Ceramic planter", 38, 3}, {"beeswax-candles", "Beeswax candle set", 28, 2},
}

// seedSource is where a visit comes from. convert scales the chance of
// buying, bounce the chance of leaving at once.
type seedSource struct {
	channel   string
	weight    float64
	convert   float64
	bounce    float64
	referrers []string // one is picked
	utm       []string // query strings; one is picked when not empty
	clickID   bool     // add a gclid
}

var seedSources = []seedSource{
	{channel: "Direct", weight: 34, convert: 1.1, bounce: 0.95},
	{channel: "Search", weight: 21, convert: 1, bounce: 1, referrers: []string{"https://www.google.com/"}},
	{channel: "Search", weight: 3.5, convert: 1, bounce: 1, referrers: []string{"https://www.bing.com/"}},
	{channel: "Search", weight: 2.5, convert: 1.05, bounce: 1, referrers: []string{"https://duckduckgo.com/"}},
	{channel: "Social", weight: 4, convert: 0.4, bounce: 1.35, referrers: []string{"https://t.co/", "https://x.com/"}},
	{channel: "Social", weight: 2, convert: 0.6, bounce: 1.2, referrers: []string{"https://www.linkedin.com/"}},
	{channel: "Social", weight: 2.5, convert: 0.5, bounce: 1.3, referrers: []string{"https://www.reddit.com/"}},
	{channel: "Social", weight: 2.5, convert: 0.4, bounce: 1.4, referrers: []string{"https://www.facebook.com/", "https://l.facebook.com/"}},
	{channel: "Social", weight: 1.5, convert: 0.45, bounce: 1.3, referrers: []string{"https://www.youtube.com/"}},
	{channel: "AI", weight: 2.5, convert: 1, bounce: 0.9, referrers: []string{"https://chatgpt.com/"}},
	{channel: "AI", weight: 1.5, convert: 1.05, bounce: 0.9, referrers: []string{"https://www.perplexity.ai/"}},
	{channel: "Referral", weight: 8, convert: 1.5, bounce: 0.8, referrers: []string{"https://slowliving.example/gift-guide",
		"https://thehomeedit.example/", "https://oakandlinen.example/reviews/fernhill", "https://makersweekly.example/issue-212"}},
	{channel: "Paid", weight: 7, convert: 0.8, bounce: 1.15, referrers: []string{"https://www.google.com/"}, clickID: true,
		utm: []string{"utm_source=google&utm_medium=cpc&utm_campaign=brand-search", "utm_source=google&utm_medium=cpc&utm_campaign=home-gifts"}},
	{channel: "Paid", weight: 3, convert: 0.7, bounce: 1.25, referrers: []string{"https://www.facebook.com/"},
		utm: []string{"utm_source=facebook&utm_medium=cpc&utm_campaign=retargeting"}},
	emailSource,
}

// emailSource is the newsletter. Its first campaign is the one the spike
// days belong to.
var emailSource = seedSource{channel: "Email", weight: 6, convert: 1.6, bounce: 0.75, utm: []string{
	"utm_source=newsletter&utm_medium=email&utm_campaign=autumn-sale",
	"utm_source=newsletter&utm_medium=email&utm_campaign=welcome-series",
	"utm_source=newsletter&utm_medium=email&utm_campaign=new-arrivals",
	"utm_source=newsletter&utm_medium=email&utm_campaign=back-in-stock",
	"utm_source=newsletter&utm_medium=email&utm_campaign=gift-guide",
	"utm_source=newsletter&utm_medium=email&utm_campaign=free-delivery-week"}}

// The funnel. From 100 visits that open the home page about 62 open a
// product, 21 add to the cart, 15 open the cart, 9 the checkout, 6 buy.
const (
	landOnProduct    = 0.12  // visits that start on a product page
	bounceHome       = 0.27  // leave the home page at once
	bounceProduct    = 0.36  // the same for a product landing
	homeToProduct    = 0.83  // of those who stay on the home page
	productToAdd     = 0.275 // scaled by the source and by returning
	returningConvert = 1.25
	addToCartPage    = 0.72
	cartToCheckout   = 0.60
	checkoutToBuy    = 0.62
	anotherProduct   = 0.30 // look at one more product, up to four
	wanderLogin      = 0.35 // of those who stay but open no product: go to /login
	wanderCart       = 0.20 // or peek at the empty cart
	keepShopping     = 0.25 // buyers who go back to the home page
)

// Things that happen on a page view.
const (
	vitalsOnRoute  = 0.30  // a later page that was a full load and measured vitals again
	strayClick     = 0.12  // a click on nothing in particular
	headerClick    = 0.04  // a click on the brand or "Shop" that goes nowhere new
	checkStock     = 0.12  // product views that press "Check store stock", which fails
	rageCompare    = 0.05  // product views with a rage click on the dead "Compare"
	deadCompare    = 0.06  // product views with one dead click on it
	deadImage      = 0.04  // product views with a click on the picture
	rageStock      = 0.25  // of failed stock checks
	rageCardField  = 0.04  // checkout views
	slowOrder      = 0.35  // orders whose POST takes 3 to 9 s
	outboundClick  = 0.008 // page views with a click on an outside link
	emailClick     = 0.003 // page views with a click on the mail link
	downloadClick  = 0.012 // product views that download the care guide
	feedbackShare  = 0.003 // visits
	feedbackEmails = 0.40  // feedback that leaves an email
)

// Releases, oldest first, each live from a fraction of the period on.
var seedReleases = []struct {
	name string
	from float64
}{{"shop@1.2.0", 0}, {"shop@1.3.0", 0.22}, {"shop@1.4.0", 0.46}, {"shop@1.5.0", 0.68}, {"shop@1.6.0", 0.91}}

// buggyRelease has a visibly higher error rate.
const buggyRelease = "shop@1.4.0"

// errorWhere is the page view an error could happen on.
type errorWhere struct {
	path    string
	product bool
	safari  bool
	daysAgo float64
	release string
}

// seedError is one kind of uncaught error. message may hold one %d filled
// from nums: the server flattens digits, so they still group.
type seedError struct {
	message string
	nums    []int
	file    string
	frames  []string
	rate    func(w errorWhere) float64 // chance per page view
}

var seedErrors = []seedError{
	{ // the common one, far worse on the buggy release
		message: "TypeError: Cannot read properties of undefined (reading 'price')", file: "app-3f2a.js",
		frames: []string{"formatPrice", "ProductPage", "renderWithHooks", "performUnitOfWork"},
		rate: func(w errorWhere) float64 {
			switch {
			case !w.product:
				return 0
			case w.release == buggyRelease:
				return 0.14
			}
			return 0.018
		}},
	{ // rare, on the home page
		message: "Error: Could not load products (%d)", nums: []int{502, 503, 504}, file: "app-3f2a.js",
		frames: []string{"loadProducts", "useProducts", "HomePage"},
		rate: func(w errorWhere) float64 {
			if w.path != "/" {
				return 0
			}
			return 0.004
		}},
	{ // rare, anywhere
		message: "ChunkLoadError: Loading chunk %d failed.", nums: []int{17, 48, 213, 482, 907}, file: "vendor-91bc.js",
		frames: []string{"__webpack_require__.f.j", "ensureChunk", "lazyInitializer"},
		rate:   func(errorWhere) float64 { return 0.0015 }},
	{ // starts in the last five days
		message: "RangeError: Invalid quantity %d for line 1", nums: []int{0, 100, 250}, file: "app-3f2a.js",
		frames: []string{"setQuantity", "CartPage", "onClick"},
		rate: func(w errorWhere) float64 {
			if w.path != "/cart" || w.daysAgo > 5 {
				return 0
			}
			return 0.14
		}},
	{ // Safari only
		message: "TypeError: undefined is not an object (evaluating 'observer.takeRecords')", file: "vendor-91bc.js",
		frames: []string{"flushObserver", "onVisibilityChange"},
		rate: func(w errorWhere) float64 {
			if !w.safari {
				return 0
			}
			return 0.012
		}},
	{ // only on the checkout
		message: "Error: Payment form failed to tokenize card (code %d)", nums: []int{4012, 4031, 5100}, file: "checkout-7d10.js",
		frames: []string{"tokenizeCard", "submit", "CheckoutPage"},
		rate: func(w errorWhere) float64 {
			if w.path != "/checkout" {
				return 0
			}
			return 0.06
		}},
	{ // rare, private browsing
		message: "SecurityError: The operation is insecure.", file: "app-3f2a.js",
		frames: []string{"readCart", "CartProvider", "mountMemo"},
		rate:   func(errorWhere) float64 { return 0.0008 }},
	{ // the example's own footer button
		message: "Error: Gift card balance service is unavailable", file: "app-3f2a.js",
		frames: []string{"onClick", "callCallback", "dispatchEvent"},
		rate:   func(errorWhere) float64 { return 0.0025 }},
}

// seedVital is a web vital: its median on a desktop product page and the
// spread of its log-normal.
type seedVital struct {
	name   string
	median float64
	sigma  float64
	share  float64 // page loads that report it
}

var seedVitals = []seedVital{{"ttfb", 180, 0.5, 1}, {"fcp", 600, 0.45, 1}, {"lcp", 1100, 0.45, 1},
	{"cls", 0.035, 1.0, 1}, {"inp", 70, 0.6, 0.7}}

// What slows a page load down.
const (
	vitalHome     = 1.35 // the home page against the others
	vitalTablet   = 1.3
	vitalMobile   = 1.7
	vitalSlowTail = 0.05 // loads that are three times slower
)

// spot is where an element sits: x in percent of the page width, y in pixels.
type spot struct{ x, y float64 }

// seedElement is something to click, with its place per device class
// (desktop as measured on the example shop at 1280 wide).
type seedElement struct {
	selector, label string
	at              [3]spot
}

var seedElements = map[string]seedElement{
	"brand":   {"div.shell > header.header > a.brand", "Fernhill Goods", [3]spot{{5, 28}, {8, 28}, {18, 26}}},
	"shop":    {"div.shell > header.header > nav.nav > a.active", "Shop", [3]spot{{84.5, 28}, {76, 28}, {58, 26}}},
	"sign-in": {"div.shell > header.header > nav.nav > a", "Sign in", [3]spot{{89.5, 28}, {84, 28}, {73, 26}}},
	"cart":    {"div.shell > header.header > nav.nav > a", "Cart", [3]spot{{95, 28}, {93, 28}, {90, 26}}},
	"back":    {"main.main > article.product > div.product-info > a.muted", "← Back to the shop", [3]spot{{57, 101}, {58, 101}, {22, 372}}},
	"add":     {"article.product > div.product-info > div.actions > button.button.primary", "Add to cart", [3]spot{{56, 351}, {57, 372}, {20, 610}}},
	"stock":   {"article.product > div.product-info > div.actions > button.button", "Check store stock", [3]spot{{68, 351}, {73, 372}, {52, 610}}},
	"compare": {"article.product > div.product-info > div.actions > button.button.ghost", "Compare", [3]spot{{80, 351}, {89, 372}, {84, 610}}},
	"image":   {"div.shell > main.main > article.product > div.swatch.large", "", [3]spot{{28, 280}, {27, 260}, {50, 200}}},
	"error":   {"div.shell > footer.footer > button.link-button", "Trigger an error", [3]spot{{95, 690}, {92, 760}, {50, 850}}},
	"checkout": {"div.shell > main.main > section.panel > a.button.primary", "Checkout",
		[3]spot{{50, 420}, {50, 430}, {50, 470}}},
	"field-name":  {"main.main > section.panel.narrow > form.form > input", "", [3]spot{{50, 230}, {50, 235}, {50, 240}}},
	"field-email": {"main.main > section.panel.narrow > form.form > input", "", [3]spot{{50, 300}, {50, 305}, {50, 315}}},
	"field-card":  {"main.main > section.panel.narrow > form.form > input.kimmi-mask", "", [3]spot{{50, 370}, {50, 375}, {50, 390}}},
	"place-order": {"main.main > section.panel.narrow > form.form > button.button.primary", "Place order",
		[3]spot{{50, 440}, {50, 445}, {50, 465}}},
	"login-submit": {"main.main > section.panel.narrow > form.form > button.button.primary", "Sign in",
		[3]spot{{50, 370}, {50, 375}, {50, 390}}},
	"keep-shopping": {"div.shell > main.main > div.empty > a.button", "Keep shopping", [3]spot{{50, 300}, {50, 300}, {50, 320}}},
	"outbound":      {"div.shell > footer.footer > a", "Instagram", [3]spot{{40, 690}, {40, 760}, {30, 850}}},
	"download":      {"main.main > article.product > div.product-info > a.muted", "Care guide (PDF)", [3]spot{{58, 420}, {59, 440}, {30, 680}}},
	"mailto":        {"div.shell > footer.footer > a", "hello@fernhill.example", [3]spot{{60, 690}, {60, 760}, {70, 850}}},
}

// The home page's product cards: four columns on a desktop, two on a
// tablet, one on a phone.
const cardSelector = "main.main > ul.grid > li.card > a.card-link"

var cardGrid = [3]struct {
	columns        []float64 // card centres in percent
	firstRow, step float64   // pixels
}{
	classDesktop: {[]float64{21, 40, 60, 79}, 336, 294},
	classTablet:  {[]float64{29, 71}, 336, 294},
	classMobile:  {[]float64{50}, 300, 250},
}

// clickJitter is the standard deviation of a click around its element, in pixels.
const clickJitter = 12

// Page heights in pixels: the home page is long.
const (
	homeHeight  = 2400
	otherHeight = 900
)

var outboundLinks = []string{"instagram.com/fernhillgoods", "pinterest.com/fernhillgoods", "trustpilot.example/review/fernhill"}

var downloadFiles = []string{"/files/care-guide.pdf", "/files/size-chart.pdf", "/files/returns-form.pdf"}

// feedbackTexts are what visitors write in the feedback box.
var feedbackTexts = []string{
	"The coupon box at checkout is confusing. I typed my code and nothing happened, no error either.",
	"Shipping costs only show up at the very last step. I would like to see them in the cart.",
	"The Compare button on the product page does nothing when I click it.",
	"Love the linen throw! Would be great to see more photos of the colours in daylight.",
	"Check store stock always says something went wrong. Is the Bristol shop still open?",
	"I could not find where to change the quantity once I was at the checkout.",
	"Do you ship to Kenya? The delivery page only mentions Europe.",
	"Checkout took ages after I pressed Place order. I nearly paid twice.",
	"The site is lovely on my laptop but the product buttons overlap on my phone.",
	"Please add Apple Pay. Typing my card number on a phone is painful.",
	"I got an error page when opening my cart, then it worked after a refresh.",
	"Is the brass lamp coming back in stock? There is no way to ask to be notified.",
	"Great prices. A wishlist would help, I keep losing track of what I looked at.",
	"The newsletter discount code expired the day I received the email.",
	"Sign in asked for my password twice and then sent me back to the home page.",
	"Could you show the mug's size in centimetres as well as millilitres?",
	"Free delivery over £75 is mentioned in the footer only. I almost missed it.",
	"The photos are tiny on a big screen. Clicking the picture should zoom in.",
	"Order went through fine and arrived in two days. Thank you!",
}
