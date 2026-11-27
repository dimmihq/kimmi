// Package store defines kimmi's index: the Store interface and the records it
// keeps. The sqlstore package implements it for SQLite and PostgreSQL.
package store

import (
	"context"
	"errors"

	"github.com/google/uuid"
)

var (
	// ErrNotFound means the row does not exist (or is not visible to the caller).
	ErrNotFound = errors.New("not found")
	// ErrConflict means a unique value (email, slug, key) is already taken.
	ErrConflict = errors.New("already exists")
)

// Store is everything kimmi reads and writes in its database. Every method
// that takes a project id trusts the caller to have checked access to it.
type Store interface {
	Driver() string
	Version(ctx context.Context) (string, error)
	Ping(ctx context.Context) error
	Close() error

	// Accounts.
	HasUsers(ctx context.Context) (bool, error)
	CreateOrgWithOwner(ctx context.Context, org Org, owner User) error
	// CreateOrg creates an organisation without users (start-up bootstrap).
	CreateOrg(ctx context.Context, org Org) error
	// FirstOrg is the oldest organisation, or ErrNotFound when there is none.
	FirstOrg(ctx context.Context) (Org, error)
	GetOrg(ctx context.Context, id string) (Org, error)
	CreateUser(ctx context.Context, u User) error
	GetUser(ctx context.Context, id string) (User, error)
	GetUserByEmail(ctx context.Context, email string) (User, error)
	ListUsers(ctx context.Context, orgID string) ([]User, error)
	UpdateUser(ctx context.Context, u User) error
	DeleteUser(ctx context.Context, orgID, id string) error
	CountOwners(ctx context.Context, orgID string) (int, error)

	CreateAuthSession(ctx context.Context, s AuthSession) error
	GetAuthSessionByHash(ctx context.Context, tokenHash string) (AuthSession, error)
	TouchAuthSession(ctx context.Context, id string, at int64) error
	ListAuthSessions(ctx context.Context, userID string) ([]AuthSession, error)
	DeleteAuthSession(ctx context.Context, userID, id string) error
	DeleteOtherAuthSessions(ctx context.Context, userID, keepID string) error

	CreateInvitation(ctx context.Context, inv Invitation) error
	ListPendingInvitations(ctx context.Context, orgID string, now int64) ([]Invitation, error)
	GetInvitationByHash(ctx context.Context, tokenHash string) (Invitation, error)
	DeleteInvitation(ctx context.Context, orgID, id string) error
	// AcceptInvitation creates the user and marks the invitation used, atomically.
	AcceptInvitation(ctx context.Context, invitationID string, u User, at int64) error

	CreateAPIToken(ctx context.Context, t APIToken) error
	ListAPITokens(ctx context.Context, orgID, userID string) ([]APIToken, error)
	GetAPITokenByHash(ctx context.Context, tokenHash string) (APIToken, error)
	TouchAPIToken(ctx context.Context, id string, at int64) error
	DeleteAPIToken(ctx context.Context, orgID, userID, id string) error

	// Projects.
	CreateProject(ctx context.Context, p Project) error
	GetProject(ctx context.Context, orgID, id string) (Project, error)
	ListProjects(ctx context.Context, orgID string) ([]Project, error)
	// ListAllProjects returns every live project of every org, for the ingest cache.
	ListAllProjects(ctx context.Context) ([]Project, error)
	UpdateProject(ctx context.Context, p Project) error
	// DeleteProject soft-deletes the project and its recordings.
	DeleteProject(ctx context.Context, orgID, id string, at int64) error
	ProjectStats(ctx context.Context, projectIDs []string, q StatsQuery) (map[string]ProjectStats, error)

	ListProjectMembers(ctx context.Context, projectID string) ([]ProjectMember, error)
	ProjectRoles(ctx context.Context, userID string) (map[string]string, error)
	PutProjectMember(ctx context.Context, projectID, userID, role string) error
	DeleteProjectMember(ctx context.Context, projectID, userID string) error

	// Ingest.
	ApplyFlush(ctx context.Context, blocks []IngestBlock, at int64) error

	// Recordings.
	ListRecordings(ctx context.Context, q RecordingQuery) (RecordingPage, error)
	GetRecording(ctx context.Context, projectID, id string) (Recording, error)
	RecordingNeighbors(ctx context.Context, projectID string, r Recording) (newer, older string, err error)
	SetRecordingFlags(ctx context.Context, projectID, id string, starred, seen *bool) error
	DeleteRecording(ctx context.Context, projectID, id string, at int64) error
	// DeleteRecordings removes the project's recordings started before
	// startedBefore (0 means all) and returns how many.
	DeleteRecordings(ctx context.Context, projectID string, startedBefore, at int64) (int, error)
	ListBlocks(ctx context.Context, sessionID string, afterSeq int64) ([]Block, error)
	Overview(ctx context.Context, q OverviewQuery) (Overview, error)
	Live(ctx context.Context, projectID string, liveSince, activeSince int64) (Live, error)

	// Visitors.
	ListVisitors(ctx context.Context, q VisitorQuery) (VisitorPage, error)
	GetVisitor(ctx context.Context, projectID, id string) (Visitor, error)
	VisitorDetail(ctx context.Context, projectID, id string, activityFrom, dayOffsetMs int64) (VisitorStats, []DayCount, error)
	// FindVisitors matches a visitor id, external id or email exactly.
	FindVisitors(ctx context.Context, projectID, query string) ([]string, error)
	// FindVisitorsByExternalIDPrefix matches visitors whose external id
	// starts with prefix, compared literally and case-sensitively.
	FindVisitorsByExternalIDPrefix(ctx context.Context, projectID, prefix string) ([]string, error)
	// DeleteVisitor removes the visitor and soft-deletes their recordings.
	DeleteVisitor(ctx context.Context, projectID, id string, at int64) error

	// Worker.
	SealCandidates(ctx context.Context, idleBefore int64, limit int) ([]SealCandidate, error)
	SealSession(ctx context.Context, r SealResult) error
	// LiveKeysInUse returns which of keys still have blocks rows.
	LiveKeysInUse(ctx context.Context, keys []string) (map[string]bool, error)
	// SealedKeysInUse returns every sealed object a recording still points to.
	SealedKeysInUse(ctx context.Context) (map[string]bool, error)
	// ExpireSessions soft-deletes recordings past their project's retention.
	ExpireSessions(ctx context.Context, now int64) (deleted int, bytes int64, err error)
	// PurgeDeleted removes soft-deleted recordings for good.
	PurgeDeleted(ctx context.Context, now int64) (int, error)
	// MaintainPartitions creates partitions ahead of time (PostgreSQL only).
	MaintainPartitions(ctx context.Context, now int64) error
	StorageReport(ctx context.Context, projectIDs []string, now int64) (StorageReport, error)
}

// Role names, from most to least powerful.
const (
	RoleOwner  = "owner"
	RoleAdmin  = "admin"
	RoleMember = "member"
	RoleViewer = "viewer"
)

// Org is a workspace.
type Org struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	CreatedAt int64  `json:"-"`
}

// User is a person who signs in to the dashboard.
type User struct {
	ID           string `json:"id"`
	OrgID        string `json:"-"`
	Name         string `json:"name"`
	Email        string `json:"email"`
	PasswordHash string `json:"-"`
	Role         string `json:"role"`
	Preferences  []byte `json:"-"`
	CreatedAt    int64  `json:"createdAt"`
	LastLoginAt  *int64 `json:"lastLoginAt"`
}

// AuthSession is one signed-in browser.
type AuthSession struct {
	ID         string
	UserID     string
	TokenHash  string
	UserAgent  string
	IP         string
	CreatedAt  int64
	LastSeenAt int64
}

// Invitation asks someone to join an org.
type Invitation struct {
	ID         string
	OrgID      string
	Email      string
	Role       string
	TokenHash  string
	InvitedBy  string
	CreatedAt  int64
	ExpiresAt  int64
	AcceptedAt *int64
}

// APIToken is a secret for scripts, stored only as a hash.
type APIToken struct {
	ID         string
	OrgID      string
	UserID     string
	Name       string
	Prefix     string
	TokenHash  string
	Access     string
	CreatedAt  int64
	LastUsedAt *int64
	ExpiresAt  *int64
}

// Project is one recorded site.
type Project struct {
	ID            string
	OrgID         string
	Name          string
	Slug          string
	Platform      string
	Origin        string
	Timezone      string
	PublicKey     string
	Origins       []string
	Settings      []byte
	RetentionDays int
	KeepStarred   bool
	CreatedAt     int64
	DeletedAt     *int64
}

// ProjectMember is a user's role in one project.
type ProjectMember struct {
	UserID       string `json:"userId"`
	Name         string `json:"name"`
	Email        string `json:"email"`
	Role         string `json:"role"`
	LastActiveAt *int64 `json:"lastActiveAt"`
}

// StatsQuery frames ProjectStats. Days are counted from DayOffsetMs-shifted UTC.
type StatsQuery struct {
	Now, LiveSince, DayOffsetMs int64
}

// ProjectStats is the summary shown on a project card.
type ProjectStats struct {
	Recordings24h   int    `json:"recordings24h"`
	Live            int    `json:"live"`
	AvgDurationMs   int64  `json:"avgDurationMs"`
	StorageBytes    int64  `json:"storageBytes"`
	Recordings      int    `json:"recordings"`
	Series          []int  `json:"series"`
	LastRecordingAt *int64 `json:"lastRecordingAt"`
}

// IngestBlock is one accepted batch, already written to a live object.
type IngestBlock struct {
	Block
	OrgID       string
	AnonymousID string
	ExternalID  string
	Email       string
	Name        string
	Traits      []byte
	StartedAt   int64
	Path        string
	Paths       []string
	Referrer    string
	Release     string
	ViewportW   int
	ViewportH   int
	Device      string
	Browser     string
	OS          string
	Country     string
	CountryCode string
	City        string
	Clicks      int
	Keypresses  int
	RageClicks  int
	DeadClicks  int
	Errors      int
	Pageviews   int
	ActiveMs    int64
}

// Block points at one batch's gzip bytes inside a live object.
type Block struct {
	SessionID string
	Seq       int64
	ProjectID string
	FileKey   string
	Offset    int64
	Length    int64
	FirstTs   int64
	LastTs    int64
	CreatedAt int64
}

// Chunk is one zstd frame of a sealed recording. A chunk holds whole blocks
// (FirstSeq to LastSeq), except that an oversized block spans several chunks.
type Chunk struct {
	Offset   int64 `json:"offset"`
	Length   int64 `json:"length"`
	FirstTs  int64 `json:"first_ts"`
	LastTs   int64 `json:"last_ts"`
	Events   int   `json:"events"`
	FirstSeq int64 `json:"first_seq"`
	LastSeq  int64 `json:"last_seq"`
}

// Visitor is one browser (or identified person) in a project.
type Visitor struct {
	ID          string  `json:"id"`
	ProjectID   string  `json:"-"`
	Name        *string `json:"name"`
	Email       *string `json:"email"`
	AnonymousID string  `json:"anonymousId"`
	ExternalID  *string `json:"externalId"`
	Country     string  `json:"country"`
	CountryCode string  `json:"countryCode"`
	City        string  `json:"city"`
	Device      string  `json:"device"`
	Browser     string  `json:"browser"`
	OS          string  `json:"os"`
	FirstSeen   int64   `json:"firstSeen"`
	LastSeen    int64   `json:"lastSeen"`
	Sessions    int     `json:"sessions"`
}

// Recording is one session with its visitor.
type Recording struct {
	ID           string
	ProjectID    string
	Visitor      Visitor
	StartedAt    int64
	LastAt       int64
	DurationMs   int64
	ActiveMs     int64
	Pages        int
	EntryPath    string
	ExitPath     string
	URLs         []string
	Clicks       int
	Keypresses   int
	RageClicks   int
	DeadClicks   int
	Errors       int
	ViewportW    int
	ViewportH    int
	Device       string
	Browser      string
	OS           string
	CountryCode  string
	City         string
	Referrer     string
	Release      string
	SizeBytes    int64
	BlockCount   int
	LastSeq      int64
	Seen         bool
	Starred      bool
	Sealed       bool
	SealedKey    string
	SealedChunks []Chunk
}

// RecordingQuery filters the recordings list. Empty strings mean no filter.
type RecordingQuery struct {
	ProjectID string
	View      string // all, unwatched, friction, starred
	Q         string
	Duration  string // any, short, medium, long
	Device    string
	Rage      bool
	Errors    bool
	VisitorID string
	Page      int
	Limit     int
}

// RecordingCounts are the tab counts above the recordings list.
type RecordingCounts struct {
	All       int `json:"all"`
	Unwatched int `json:"unwatched"`
	Friction  int `json:"friction"`
	Starred   int `json:"starred"`
}

// RecordingPage is one page of recordings.
type RecordingPage struct {
	Items  []Recording
	Total  int
	Counts RecordingCounts
}

// OverviewQuery frames a project overview. From..To is the window, PrevFrom
// starts the window before it, TodayFrom is the start of the project's today.
type OverviewQuery struct {
	ProjectID                     string
	From, To, PrevFrom, TodayFrom int64
	DayOffsetMs                   int64
}

// Overview is the project overview page.
type Overview struct {
	Totals    OverviewTotals `json:"totals"`
	Days      []DayFriction  `json:"days"`
	TopPages  []PageStat     `json:"topPages"`
	Devices   []NameCount    `json:"devices"`
	Countries []CountryCount `json:"countries"`
}

// OverviewTotals are the headline numbers of an overview.
type OverviewTotals struct {
	Recordings       int     `json:"recordings"`
	Today            int     `json:"today"`
	AvgDurationMs    int64   `json:"avgDurationMs"`
	AvgActiveMs      int64   `json:"avgActiveMs"`
	FrictionSessions int     `json:"frictionSessions"`
	ErrorSessions    int     `json:"errorSessions"`
	TrendPercent     float64 `json:"trendPercent"`
}

// DayFriction splits one day's recordings by what went wrong in them.
type DayFriction struct {
	Date     string `json:"date"`
	Clean    int    `json:"clean"`
	Friction int    `json:"friction"`
	Errors   int    `json:"errors"`
}

// PageStat counts recordings that visited a path.
type PageStat struct {
	Path  string `json:"path"`
	Views int    `json:"views"`
	Rage  int    `json:"rage"`
}

// NameCount is a labelled count.
type NameCount struct {
	Name  string `json:"name"`
	Count int    `json:"count"`
}

// CountryCount is a count per country.
type CountryCount struct {
	Code  string `json:"code"`
	Name  string `json:"name"`
	Count int    `json:"count"`
}

// PathCount is a count per path.
type PathCount struct {
	Path  string `json:"path"`
	Count int    `json:"count"`
}

// Live is who is on the site right now.
type Live struct {
	Visitors     int
	ActiveLast5m int
	Pages        []PathCount
	Countries    []CountryCount
	Sessions     []Recording
}

// VisitorQuery filters the visitors list.
type VisitorQuery struct {
	ProjectID string
	Q         string
	Kind      string // all, identified, anonymous
	Sort      string // lastSeen, sessions, firstSeen
	Page      int
	Limit     int
}

// VisitorCounts are the tab counts above the visitors list.
type VisitorCounts struct {
	All        int `json:"all"`
	Identified int `json:"identified"`
	Anonymous  int `json:"anonymous"`
}

// VisitorPage is one page of visitors.
type VisitorPage struct {
	Items  []Visitor
	Total  int
	Counts VisitorCounts
}

// VisitorStats sums a visitor's recordings.
type VisitorStats struct {
	Sessions        int   `json:"sessions"`
	TotalDurationMs int64 `json:"totalDurationMs"`
	RageClicks      int   `json:"rageClicks"`
	Errors          int   `json:"errors"`
}

// DayCount is a count on one day.
type DayCount struct {
	Date  string `json:"date"`
	Count int    `json:"count"`
}

// SealCandidate is an idle recording the sealer should pack.
type SealCandidate struct {
	ID            string
	ProjectID     string
	RetentionDays int
	SealedKey     string
	SealedChunks  []Chunk
	Blocks        []Block
}

// SealResult records where a recording was packed. Only blocks up to
// UpToSeq are removed, so a batch that arrived meanwhile survives.
type SealResult struct {
	SessionID string
	Key       string
	Chunks    []Chunk
	SizeBytes int64
	LastSeq   int64
	UpToSeq   int64
}

// StorageReport is the instance storage page.
type StorageReport struct {
	TotalBytes            int64            `json:"totalBytes"`
	Recordings            int              `json:"recordings"`
	Projects              []ProjectStorage `json:"projects"`
	Ages                  []AgeBucket      `json:"ages"`
	NextCleanupFreesBytes int64            `json:"nextCleanupFreesBytes"`
}

// ProjectStorage is one project's share of storage.
type ProjectStorage struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	Platform      string `json:"platform"`
	Bytes         int64  `json:"bytes"`
	Recordings    int    `json:"recordings"`
	RetentionDays int    `json:"retentionDays"`
}

// AgeBucket groups stored bytes by recording age. ExpiringBytes will pass
// retention within the next 7 days.
type AgeBucket struct {
	Label         string `json:"label"`
	Bytes         int64  `json:"bytes"`
	ExpiringBytes int64  `json:"expiringBytes"`
}

// NewID returns a new UUIDv7 string.
func NewID() string { return uuid.Must(uuid.NewV7()).String() }

// DayMs is one day in milliseconds.
const DayMs = 86_400_000
