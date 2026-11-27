package store

import "context"

// Analytics is everything kimmi keeps beside recordings: visits and the
// small events inside them, and what people attach to recordings (notes,
// share links, feedback). The sqlstore package implements it on both
// databases; Store embeds it.
type Analytics interface {
	// ApplyHits indexes one flush of analytics hits in a single transaction:
	// it creates or extends each hit's visit and appends its events.
	ApplyHits(ctx context.Context, hits []Hit) error
	// DaySalt returns the secret that cookieless visitor hashes of day
	// (YYYY-MM-DD, UTC) are made with, creating it when it does not exist,
	// and forgets every salt of an earlier day.
	DaySalt(ctx context.Context, day string) (string, error)

	Traffic(ctx context.Context, q AnalyticsQuery) (Traffic, error)
	// Goals counts the visits in the window that reached each goal.
	Goals(ctx context.Context, q AnalyticsQuery, goals []Step) ([]int, error)
	// GoalSources splits one goal's converting visits by referrer.
	GoalSources(ctx context.Context, q AnalyticsQuery, goal Step) ([]NameCount, error)
	EventNames(ctx context.Context, q AnalyticsQuery) ([]EventStat, error)
	ErrorGroups(ctx context.Context, q AnalyticsQuery) ([]ErrorGroup, error)
	// ErrorGroup is one group with its latest occurrences; ErrNotFound when
	// the window holds none.
	ErrorGroup(ctx context.Context, q AnalyticsQuery, fingerprint string) (ErrorGroup, []Occurrence, error)
	Friction(ctx context.Context, q AnalyticsQuery) (Friction, error)
	Requests(ctx context.Context, q AnalyticsQuery) ([]RequestStat, error)
	Vitals(ctx context.Context, q AnalyticsQuery) ([]PageVitals, error)
	// Funnel counts the visits that reached each step in order, and lists
	// up to 200 visits that stopped after each step.
	Funnel(ctx context.Context, q AnalyticsQuery, steps []Step) ([]FunnelStep, error)
	HeatmapPages(ctx context.Context, q AnalyticsQuery) ([]PathCount, error)
	Heatmap(ctx context.Context, q HeatmapQuery) (Heatmap, error)
	Retention(ctx context.Context, q RetentionQuery) (Retention, error)
	Releases(ctx context.Context, q AnalyticsQuery) ([]ReleaseStat, error)
	Accounts(ctx context.Context, projectID string) ([]Account, error)
	// RecordingsByID returns the live recordings among ids, newest first.
	RecordingsByID(ctx context.Context, projectID string, ids []string) ([]Recording, error)

	// CountEvents counts a project's events of one kind since a time.
	CountEvents(ctx context.Context, projectID, kind string, since int64) (int, error)
	// EventSeenBefore reports whether the project has an event of this kind
	// and name older than before.
	EventSeenBefore(ctx context.Context, projectID, kind, name string, before int64) (bool, error)
	// LastVisitAt is when the project last saw a visit (0: never).
	LastVisitAt(ctx context.Context, projectID string) (int64, error)
	// DeleteAnalyticsBefore removes a project's visits, events and feedback
	// older than before, and returns how many visits went.
	DeleteAnalyticsBefore(ctx context.Context, projectID string, before int64) (int, error)

	CreateNote(ctx context.Context, n Note) error
	ListNotes(ctx context.Context, projectID, sessionID string) ([]Note, error)
	DeleteNote(ctx context.Context, projectID, id string) error

	CreateShare(ctx context.Context, s Share) error
	// ListShares returns the project's links that have not expired.
	ListShares(ctx context.Context, projectID string, now int64) ([]Share, error)
	// GetShareByHash finds a link that has not expired, whose project is
	// live and, for a recording link, whose recording still exists.
	GetShareByHash(ctx context.Context, tokenHash string, now int64) (Share, error)
	DeleteShare(ctx context.Context, projectID, id string) error

	CreateFeedback(ctx context.Context, f Feedback) error
	ListFeedback(ctx context.Context, projectID string, page, limit int) (FeedbackPage, error)
	SetFeedbackSeen(ctx context.Context, projectID, id string, seen bool) error
	DeleteFeedback(ctx context.Context, projectID, id string) error

	// GetState reads a small named value of a project ("" when unset).
	GetState(ctx context.Context, projectID, name string) (string, error)
	SetState(ctx context.Context, projectID, name, value string, at int64) error
}

// Event kinds.
const (
	KindPage    = "page"    // a page view: Path, Label is the title
	KindLeave   = "leave"   // leaving a page: Value is engaged ms, Num the deepest scroll in percent, Y the page height
	KindTrack   = "track"   // kimmi.track and automatic events ($outbound, $download, $email, $phone, $form): Name, Props, Value
	KindError   = "error"   // Name is the fingerprint, Label the message, Props {"source","stack"}
	KindRage    = "rage"    // Name is the selector, Label the element text, Value the clicks
	KindDead    = "dead"    // Name is the selector, Label the element text
	KindClick   = "click"   // Name selector, Label text, X in 1/10000 of the page width, Y page pixels, W viewport width
	KindRequest = "request" // a failed or slow request: Name "METHOD host/path", Value ms, Num the status
	KindVital   = "vital"   // Name lcp|inp|cls|fcp|ttfb, Value
)

// Hit is one analytics post from the SDK, resolved by the ingest handler.
type Hit struct {
	OrgID, ProjectID string
	// VisitID is the visit the SDK named. For a cookieless hit the store
	// replaces it with the visitor's visit of the last 30 minutes, if any.
	VisitID string
	// VisitorKey is "a:" and the anonymous id, or "h:" and the day's hash.
	VisitorKey  string
	Cookieless  bool
	StartedAt   int64
	At          int64
	Referrer    string // host of an external referrer, "" for none
	Channel     string
	UTMSource   string
	UTMMedium   string
	UTMCampaign string
	CountryCode string
	Device      string
	Browser     string
	OS          string
	Language    string
	ViewportW   int
	Release     string
	Events      []Event
}

// Event is one row of the event index.
type Event struct {
	Ts    int64
	Kind  string
	Path  string
	Name  string
	Label string
	Value float64
	X     int
	Y     int
	W     int
	Num   int
	Props string
}

// VisitFilter narrows analytics to matching visits. Empty fields match all.
type VisitFilter struct {
	Path        string // a visit that viewed this path
	Entry       string
	Exit        string
	Referrer    string // "Direct" matches visits without one
	Channel     string
	UTMSource   string
	UTMCampaign string
	Country     string
	Device      string
	Browser     string
	OS          string
	Language    string
}

// AnalyticsQuery frames an analytics read: From..To is the window and
// PrevFrom starts the window before it.
type AnalyticsQuery struct {
	ProjectID          string
	From, To, PrevFrom int64
	DayOffsetMs        int64
	Filter             VisitFilter
}

// Step is one goal or funnel step: a page (Value is a path, or a prefix
// ending in *) or a tracked event (Value is its name).
type Step struct {
	Kind  string `json:"kind"` // page or event
	Value string `json:"value"`
}

// Traffic is the analytics page.
type Traffic struct {
	Totals     TrafficTotals `json:"totals"`
	Previous   TrafficTotals `json:"previous"`
	Days       []TrafficDay  `json:"days"`
	Sources    []Breakdown   `json:"sources"`
	Channels   []Breakdown   `json:"channels"`
	Campaigns  []Breakdown   `json:"campaigns"`
	Pages      []PageMetric  `json:"pages"`
	EntryPages []Breakdown   `json:"entryPages"`
	ExitPages  []Breakdown   `json:"exitPages"`
	Countries  []Breakdown   `json:"countries"`
	Devices    []Breakdown   `json:"devices"`
	Browsers   []Breakdown   `json:"browsers"`
	Systems    []Breakdown   `json:"systems"`
	Languages  []Breakdown   `json:"languages"`
}

// TrafficTotals are the headline numbers of a window. A bounce is a visit
// with one page view, no click or tracked event and under 10 s engaged.
type TrafficTotals struct {
	Visitors      int   `json:"visitors"`
	Visits        int   `json:"visits"`
	Pageviews     int   `json:"pageviews"`
	Bounces       int   `json:"bounces"`
	AvgDurationMs int64 `json:"avgDurationMs"`
	NewVisitors   int   `json:"newVisitors"`
	Returning     int   `json:"returning"`
}

// TrafficDay is one day of the chart.
type TrafficDay struct {
	Date      string `json:"date"`
	Visitors  int    `json:"visitors"`
	Visits    int    `json:"visits"`
	Pageviews int    `json:"pageviews"`
}

// Breakdown is one row of a traffic panel. At most 10 rows come back,
// most visitors first; an empty value is named "Direct" (sources), "None"
// (campaigns) or "Unknown".
type Breakdown struct {
	Name     string `json:"name"`
	Visitors int    `json:"visitors"`
	Visits   int    `json:"visits"`
}

// PageMetric is one page's numbers. Scroll is the average deepest scroll in
// percent (0 when unknown).
type PageMetric struct {
	Path      string `json:"path"`
	Views     int    `json:"views"`
	Visitors  int    `json:"visitors"`
	AvgTimeMs int64  `json:"avgTimeMs"`
	Exits     int    `json:"exits"`
	Scroll    int    `json:"scroll"`
}

// EventStat counts one tracked event.
type EventStat struct {
	Name   string  `json:"name"`
	Count  int     `json:"count"`
	Visits int     `json:"visits"`
	Value  float64 `json:"value"` // sum of the events' values
}

// ErrorGroup is one kind of error.
type ErrorGroup struct {
	Fingerprint string `json:"fingerprint"`
	Message     string `json:"message"`
	Source      string `json:"source"`
	Count       int    `json:"count"`
	Visits      int    `json:"visits"`
	FirstSeen   int64  `json:"firstSeen"` // within the project, not the window
	LastSeen    int64  `json:"lastSeen"`
	Path        string `json:"path"` // where it happens most
}

// Occurrence is one event with the visit it happened in.
type Occurrence struct {
	VisitID string `json:"visitId"`
	Ts      int64  `json:"ts"`
	Path    string `json:"path"`
	Label   string `json:"label"`
	Props   string `json:"props"`
	Browser string `json:"browser"`
	OS      string `json:"os"`
	Release string `json:"release"`
	// Recorded says a recording with the visit's id exists; StartedAt is
	// when it began, so a player can open at Ts-StartedAt.
	Recorded  bool  `json:"recorded"`
	StartedAt int64 `json:"startedAt"`
}

// Friction ranks where visitors struggle.
type Friction struct {
	Pages    []PageFriction    `json:"pages"`
	Elements []ElementFriction `json:"elements"`
}

// PageFriction is one page's share of troubled visits.
type PageFriction struct {
	Path   string `json:"path"`
	Visits int    `json:"visits"` // visits that viewed the page
	Rage   int    `json:"rage"`   // visits with a rage click on it
	Dead   int    `json:"dead"`
	Errors int    `json:"errors"`
}

// ElementFriction is one element people rage-click or dead-click.
type ElementFriction struct {
	Kind     string `json:"kind"` // rage or dead
	Path     string `json:"path"`
	Selector string `json:"selector"`
	Label    string `json:"label"`
	Count    int    `json:"count"`
	Visits   int    `json:"visits"`
	// VisitID and Ts point at the latest occurrence.
	VisitID string `json:"visitId"`
	Ts      int64  `json:"ts"`
}

// RequestStat is one endpoint that fails or is slow.
type RequestStat struct {
	Name     string `json:"name"` // "GET api.acme.dev/cart"
	Count    int    `json:"count"`
	Failed   int    `json:"failed"` // status 0 or 400 and above
	Visits   int    `json:"visits"`
	AvgMs    int64  `json:"avgMs"`
	Status   int    `json:"status"` // the most common failing status, 0 when none
	VisitID  string `json:"visitId"`
	Ts       int64  `json:"ts"`
	LastSeen int64  `json:"lastSeen"`
}

// PageVitals holds a page's 75th percentiles. A negative value means the
// metric was never measured there.
type PageVitals struct {
	Path    string  `json:"path"` // "" is the whole site
	Samples int     `json:"samples"`
	LCP     float64 `json:"lcp"`
	INP     float64 `json:"inp"`
	CLS     float64 `json:"cls"`
	FCP     float64 `json:"fcp"`
	TTFB    float64 `json:"ttfb"`
}

// FunnelStep is how many visits got this far and who stopped here.
type FunnelStep struct {
	Visits  int      `json:"visits"`
	Dropped []string `json:"-"` // visit ids that reached this step and not the next
}

// HeatmapQuery picks one page and one device class.
type HeatmapQuery struct {
	ProjectID string
	From, To  int64
	Path      string
	Device    string // Desktop, Tablet or Mobile, by viewport width
}

// Heatmap is where people clicked on a page and how far they scrolled.
type Heatmap struct {
	Clicks int `json:"clicks"`
	// Cells are clicks in a grid: X in percent of the page width (0 to 99),
	// Y in steps of 10 page pixels.
	Cells    []HeatCell     `json:"cells"`
	Elements []HeatElement  `json:"elements"`
	Views    int            `json:"views"`  // page leaves with a scroll depth
	Scroll   [10]int        `json:"scroll"` // views that reached 10%, 20% ... 100%
	Height   int            `json:"height"` // median page height in pixels
	Width    int            `json:"width"`  // median viewport width
	Snapshot *HeatmapSource `json:"snapshot"`
}

// HeatCell is one grid cell.
type HeatCell struct {
	X int `json:"x"`
	Y int `json:"y"`
	N int `json:"n"`
}

// HeatElement is one clicked element.
type HeatElement struct {
	Selector string `json:"selector"`
	Label    string `json:"label"`
	Count    int    `json:"count"`
}

// HeatmapSource is a recording that shows the page, to draw under the map.
type HeatmapSource struct {
	RecordingID string `json:"recordingId"`
	Ts          int64  `json:"ts"` // when the page was viewed
	StartedAt   int64  `json:"startedAt"`
}

// RetentionQuery frames the returning-visitors report.
type RetentionQuery struct {
	ProjectID   string
	Now         int64
	DayOffsetMs int64
	Weeks       int
}

// Retention is how many people are active and how many come back.
type Retention struct {
	Daily   int      `json:"daily"`   // visitors in the last 24 hours
	Weekly  int      `json:"weekly"`  // last 7 days
	Monthly int      `json:"monthly"` // last 30 days
	Cohorts []Cohort `json:"cohorts"`
}

// Cohort is the visitors first seen in one week, and how many of them were
// active in that week and each one after.
type Cohort struct {
	Week   string `json:"week"` // the Monday it starts on
	Size   int    `json:"size"`
	Active []int  `json:"active"`
}

// ReleaseStat is one release's health among recorded sessions.
type ReleaseStat struct {
	Release   string `json:"release"`
	FirstSeen int64  `json:"firstSeen"`
	LastSeen  int64  `json:"lastSeen"`
	Sessions  int    `json:"sessions"`
	Errors    int    `json:"errors"`   // sessions with an error
	Friction  int    `json:"friction"` // sessions with a rage or dead click
}

// Account groups identified visitors by the domain of their email.
type Account struct {
	Domain   string `json:"domain"`
	People   int    `json:"people"`
	Sessions int    `json:"sessions"`
	LastSeen int64  `json:"lastSeen"`
}

// Note is a comment on a moment of a recording.
type Note struct {
	ID        string `json:"id"`
	OrgID     string `json:"-"`
	ProjectID string `json:"-"`
	SessionID string `json:"recordingId"`
	UserID    string `json:"userId"`
	Author    string `json:"author"` // filled on read
	AtMs      int64  `json:"atMs"`
	Body      string `json:"body"`
	CreatedAt int64  `json:"createdAt"`
}

// Share kinds.
const (
	ShareRecording = "recording"
	ShareDashboard = "dashboard"
)

// Share is a public, expiring link to one recording or to the analytics
// page. Only the hash of its token is stored.
type Share struct {
	ID        string `json:"id"`
	OrgID     string `json:"-"`
	ProjectID string `json:"-"`
	Kind      string `json:"kind"`
	SessionID string `json:"recordingId"` // "" for a dashboard link
	StartMs   int64  `json:"startMs"`
	TokenHash string `json:"-"`
	CreatedBy string `json:"createdBy"`
	Author    string `json:"author"` // filled on read
	CreatedAt int64  `json:"createdAt"`
	ExpiresAt int64  `json:"expiresAt"`
}

// Feedback is a message a visitor sent from the site.
type Feedback struct {
	ID         string `json:"id"`
	OrgID      string `json:"-"`
	ProjectID  string `json:"-"`
	VisitID    string `json:"visitId"`
	VisitorKey string `json:"-"`
	Path       string `json:"path"`
	Body       string `json:"body"`
	Email      string `json:"email"`
	CreatedAt  int64  `json:"createdAt"`
	Seen       bool   `json:"seen"`
	// Recorded and StartedAt are filled on read, as in Occurrence.
	Recorded  bool  `json:"recorded"`
	StartedAt int64 `json:"startedAt"`
}

// FeedbackPage is one page of feedback, newest first.
type FeedbackPage struct {
	Items  []Feedback `json:"items"`
	Total  int        `json:"total"`
	Unseen int        `json:"unseen"`
}
