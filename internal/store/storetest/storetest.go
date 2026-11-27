// Package storetest is the conformance suite every store.Store must pass.
package storetest

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/dimmihq/kimmi/internal/store"
)

const day = int64(86_400_000)

// Run runs the suite. open returns an empty, migrated store for one subtest.
func Run(t *testing.T, open func(t *testing.T) store.Store) {
	t.Run("accounts", func(t *testing.T) { testAccounts(t, open(t)) })
	t.Run("projects", func(t *testing.T) { testProjects(t, open(t)) })
	t.Run("ingest", func(t *testing.T) { testIngest(t, open(t)) })
	t.Run("recordings", func(t *testing.T) { testRecordings(t, open(t)) })
	t.Run("aggregates", func(t *testing.T) { testAggregates(t, open(t)) })
	t.Run("visitors", func(t *testing.T) { testVisitors(t, open(t)) })
	t.Run("visitors by external id prefix", func(t *testing.T) { testVisitorPrefix(t, open(t)) })
	t.Run("worker", func(t *testing.T) { testWorker(t, open(t)) })
	t.Run("hits", func(t *testing.T) { testHits(t, open(t)) })
	t.Run("traffic", func(t *testing.T) { testTraffic(t, open(t)) })
	t.Run("goals and funnels", func(t *testing.T) { testGoals(t, open(t)) })
	t.Run("errors and friction", func(t *testing.T) { testErrors(t, open(t)) })
	t.Run("heatmap", func(t *testing.T) { testHeatmap(t, open(t)) })
	t.Run("retention", func(t *testing.T) { testRetention(t, open(t)) })
	t.Run("releases, accounts and recording filters", func(t *testing.T) { testInsights(t, open(t)) })
	t.Run("day salt", func(t *testing.T) { testDaySalt(t, open(t)) })
	t.Run("notes, shares, feedback and state", func(t *testing.T) { testAttachments(t, open(t)) })
	t.Run("analytics deletes", func(t *testing.T) { testAnalyticsDeletes(t, open(t)) })
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func eq[T comparable](t *testing.T, what string, got, want T) {
	t.Helper()
	if got != want {
		t.Fatalf("%s = %v, want %v", what, got, want)
	}
}

func ptr[T any](v T) *T { return &v }

var ctx = context.Background()

func seedOrg(t *testing.T, s store.Store) (store.Org, store.User) {
	t.Helper()
	now := time.Now().UnixMilli()
	org := store.Org{ID: store.NewID(), Name: "Acme", CreatedAt: now}
	owner := store.User{ID: store.NewID(), OrgID: org.ID, Name: "Ada", Email: "Ada@Example.com", PasswordHash: "x", Role: store.RoleOwner, CreatedAt: now}
	must(t, s.CreateOrgWithOwner(ctx, org, owner))
	owner.Email = "ada@example.com"
	return org, owner
}

func seedProject(t *testing.T, s store.Store, orgID, name string) store.Project {
	t.Helper()
	id := store.NewID()
	p := store.Project{ID: id, OrgID: orgID, Name: name, Slug: name + "-" + id[len(id)-6:], Platform: "react", Origin: "https://acme.dev",
		Timezone: "UTC", PublicKey: "km_pub_" + id[len(id)-16:], Origins: []string{}, Settings: []byte(`{}`),
		RetentionDays: 30, KeepStarred: true, CreatedAt: time.Now().UnixMilli()}
	must(t, s.CreateProject(ctx, p))
	return p
}

func testAccounts(t *testing.T, s store.Store) {
	has, err := s.HasUsers(ctx)
	must(t, err)
	eq(t, "HasUsers before", has, false)
	org, owner := seedOrg(t, s)
	has, _ = s.HasUsers(ctx)
	eq(t, "HasUsers after", has, true)

	got, err := s.GetUserByEmail(ctx, "ADA@example.COM")
	must(t, err)
	eq(t, "user id", got.ID, owner.ID)
	eq(t, "email lowercased", got.Email, "ada@example.com")
	eq(t, "preferences default", string(got.Preferences), "{}")

	dup := store.User{ID: store.NewID(), OrgID: org.ID, Name: "B", Email: "ada@example.com", PasswordHash: "x", Role: store.RoleMember}
	if err := s.CreateUser(ctx, dup); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("duplicate email: %v", err)
	}
	if _, err := s.GetUser(ctx, "nope"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("missing user: %v", err)
	}

	member := store.User{ID: store.NewID(), OrgID: org.ID, Name: "Bo", Email: "bo@example.com", PasswordHash: "x", Role: store.RoleMember, CreatedAt: 1}
	must(t, s.CreateUser(ctx, member))
	member.Role, member.LastLoginAt, member.Preferences = store.RoleAdmin, ptr(int64(5)), []byte(`{"theme":"dark"}`)
	must(t, s.UpdateUser(ctx, member))
	got, _ = s.GetUser(ctx, member.ID)
	eq(t, "updated role", got.Role, store.RoleAdmin)
	eq(t, "updated prefs", string(got.Preferences), `{"theme":"dark"}`)
	eq(t, "last login", *got.LastLoginAt, 5)
	users, err := s.ListUsers(ctx, org.ID)
	must(t, err)
	eq(t, "users", len(users), 2)
	n, _ := s.CountOwners(ctx, org.ID)
	eq(t, "owners", n, 1)

	a := store.AuthSession{ID: store.NewID(), UserID: owner.ID, TokenHash: "h1", UserAgent: "ua", IP: "1.2.3.0", CreatedAt: 1, LastSeenAt: 1}
	b := store.AuthSession{ID: store.NewID(), UserID: owner.ID, TokenHash: "h2", UserAgent: "ua", IP: "1.2.3.0", CreatedAt: 2, LastSeenAt: 2}
	must(t, s.CreateAuthSession(ctx, a))
	must(t, s.CreateAuthSession(ctx, b))
	must(t, s.TouchAuthSession(ctx, a.ID, 9))
	got2, err := s.GetAuthSessionByHash(ctx, "h1")
	must(t, err)
	eq(t, "touched", got2.LastSeenAt, 9)
	list, _ := s.ListAuthSessions(ctx, owner.ID)
	eq(t, "auth sessions", len(list), 2)
	eq(t, "most recent first", list[0].ID, a.ID)
	must(t, s.DeleteOtherAuthSessions(ctx, owner.ID, a.ID))
	list, _ = s.ListAuthSessions(ctx, owner.ID)
	eq(t, "after delete others", len(list), 1)
	must(t, s.DeleteAuthSession(ctx, owner.ID, a.ID))
	if _, err := s.GetAuthSessionByHash(ctx, "h1"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("deleted auth session: %v", err)
	}

	now := time.Now().UnixMilli()
	inv := store.Invitation{ID: store.NewID(), OrgID: org.ID, Email: "Cy@example.com", Role: store.RoleViewer, TokenHash: "ih", InvitedBy: owner.ID, CreatedAt: now, ExpiresAt: now + day}
	expired := store.Invitation{ID: store.NewID(), OrgID: org.ID, Email: "old@example.com", Role: store.RoleViewer, TokenHash: "ih2", InvitedBy: owner.ID, CreatedAt: 1, ExpiresAt: 2}
	must(t, s.CreateInvitation(ctx, inv))
	must(t, s.CreateInvitation(ctx, expired))
	pending, _ := s.ListPendingInvitations(ctx, org.ID, now)
	eq(t, "pending", len(pending), 1)
	gotInv, err := s.GetInvitationByHash(ctx, "ih")
	must(t, err)
	eq(t, "invite email", gotInv.Email, "cy@example.com")
	cy := store.User{ID: store.NewID(), OrgID: org.ID, Name: "Cy", Email: "cy@example.com", PasswordHash: "x", Role: store.RoleViewer, CreatedAt: now}
	must(t, s.AcceptInvitation(ctx, inv.ID, cy, now))
	if err := s.AcceptInvitation(ctx, inv.ID, store.User{ID: store.NewID(), OrgID: org.ID, Email: "z@z.z", Role: "viewer"}, now); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("second accept: %v", err)
	}
	pending, _ = s.ListPendingInvitations(ctx, org.ID, now)
	eq(t, "pending after accept", len(pending), 0)
	must(t, s.DeleteInvitation(ctx, org.ID, expired.ID))

	tok := store.APIToken{ID: store.NewID(), OrgID: org.ID, UserID: owner.ID, Name: "ci", Prefix: "km_sec_ab", TokenHash: "th", Access: "read", CreatedAt: now, ExpiresAt: ptr(now + day)}
	must(t, s.CreateAPIToken(ctx, tok))
	must(t, s.TouchAPIToken(ctx, tok.ID, now+1))
	gotTok, err := s.GetAPITokenByHash(ctx, "th")
	must(t, err)
	eq(t, "token used", *gotTok.LastUsedAt, now+1)
	toks, _ := s.ListAPITokens(ctx, org.ID, owner.ID)
	eq(t, "tokens", len(toks), 1)
	if err := s.DeleteAPIToken(ctx, org.ID, member.ID, tok.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("delete someone else's token: %v", err)
	}
	must(t, s.DeleteAPIToken(ctx, org.ID, owner.ID, tok.ID))

	must(t, s.DeleteUser(ctx, org.ID, member.ID))
	users, _ = s.ListUsers(ctx, org.ID)
	eq(t, "users after delete", len(users), 2)
}

func testProjects(t *testing.T, s store.Store) {
	org, owner := seedOrg(t, s)
	p := seedProject(t, s, org.ID, "shop")
	dup := p
	dup.ID = store.NewID()
	dup.Slug = "other"
	if err := s.CreateProject(ctx, dup); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("duplicate key: %v", err)
	}
	dup.PublicKey = "km_pub_0000000000000000"
	dup.Slug = p.Slug
	if err := s.CreateProject(ctx, dup); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("duplicate slug: %v", err)
	}

	p.Name, p.Origins, p.Settings, p.RetentionDays = "Shop", []string{"https://acme.dev"}, []byte(`{"capture":{"sampleRate":50}}`), 90
	must(t, s.UpdateProject(ctx, p))
	got, err := s.GetProject(ctx, org.ID, p.ID)
	must(t, err)
	eq(t, "name", got.Name, "Shop")
	eq(t, "origins", len(got.Origins), 1)
	eq(t, "settings", string(got.Settings), `{"capture":{"sampleRate":50}}`)
	eq(t, "retention", got.RetentionDays, 90)
	if _, err := s.GetProject(ctx, "other-org", p.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("project of another org: %v", err)
	}

	must(t, s.PutProjectMember(ctx, p.ID, owner.ID, store.RoleViewer))
	must(t, s.PutProjectMember(ctx, p.ID, owner.ID, store.RoleMember))
	members, err := s.ListProjectMembers(ctx, p.ID)
	must(t, err)
	eq(t, "members", len(members), 1)
	eq(t, "member role", members[0].Role, store.RoleMember)
	roles, _ := s.ProjectRoles(ctx, owner.ID)
	eq(t, "role map", roles[p.ID], store.RoleMember)
	must(t, s.DeleteProjectMember(ctx, p.ID, owner.ID))
	if err := s.DeleteProjectMember(ctx, p.ID, owner.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("delete missing member: %v", err)
	}

	q := seedProject(t, s, org.ID, "blog")
	all, _ := s.ListAllProjects(ctx)
	eq(t, "all projects", len(all), 2)
	must(t, s.DeleteProject(ctx, org.ID, q.ID, 1))
	list, _ := s.ListProjects(ctx, org.ID)
	eq(t, "projects after delete", len(list), 1)
	if _, err := s.GetProject(ctx, org.ID, q.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("deleted project: %v", err)
	}
	again := q
	again.ID, again.PublicKey = store.NewID(), "km_pub_1111111111111111"
	must(t, s.CreateProject(ctx, again))
}

// batch builds one ingest block for session sid.
func batch(p store.Project, sid, anon string, seq, ts int64) store.IngestBlock {
	return store.IngestBlock{
		Block: store.Block{SessionID: sid, Seq: seq, ProjectID: p.ID, FileKey: fmt.Sprintf("live/f-%d.bin", seq), Offset: seq * 100,
			Length: 100, FirstTs: ts, LastTs: ts + 1000, CreatedAt: ts},
		OrgID: p.OrgID, AnonymousID: anon, StartedAt: ts - seq*1000, Path: "/p" + fmt.Sprint(seq), Paths: []string{"/p" + fmt.Sprint(seq)},
		Referrer: "https://google.com/", ViewportW: 1440, ViewportH: 900, Device: "Desktop", Browser: "Chrome", OS: "macOS",
		Country: "Nigeria", CountryCode: "NG", City: "Lagos", Clicks: 2, Keypresses: 3, Pageviews: 1, ActiveMs: 500,
	}
}

func testIngest(t *testing.T, s store.Store) {
	org, _ := seedOrg(t, s)
	p := seedProject(t, s, org.ID, "shop")
	now := time.Now().UnixMilli()
	sid := store.NewID()

	b0, b1 := batch(p, sid, "anon-1", 0, now), batch(p, sid, "anon-1", 1, now+1000)
	b1.RageClicks, b1.Release = 1, "v1"
	must(t, s.ApplyFlush(ctx, []store.IngestBlock{b0, b1, b0}, now))
	b2 := batch(p, sid, "anon-1", 2, now+2000)
	b2.ExternalID, b2.Email, b2.Name, b2.Traits = "user-42", "a@b.c", "Ada", []byte(`{"plan":"pro"}`)
	// b1 again is a retry of an already stored batch and must change nothing.
	must(t, s.ApplyFlush(ctx, []store.IngestBlock{b1, b2}, now))

	r, err := s.GetRecording(ctx, p.ID, sid)
	must(t, err)
	eq(t, "clicks", r.Clicks, 6)
	eq(t, "rage", r.RageClicks, 1)
	eq(t, "pages", r.Pages, 3)
	eq(t, "blocks", r.BlockCount, 3)
	eq(t, "size", r.SizeBytes, 300)
	eq(t, "started", r.StartedAt, now)
	eq(t, "last", r.LastAt, now+3000)
	eq(t, "duration", r.DurationMs, 3000)
	eq(t, "entry", r.EntryPath, "/p0")
	eq(t, "exit", r.ExitPath, "/p2")
	eq(t, "last seq", r.LastSeq, 2)
	eq(t, "release", r.Release, "v1")
	eq(t, "urls", len(r.URLs), 3)
	eq(t, "visitor sessions", r.Visitor.Sessions, 1)
	eq(t, "visitor external id", *r.Visitor.ExternalID, "user-42")
	eq(t, "visitor city", r.Visitor.City, "Lagos")

	blocks, err := s.ListBlocks(ctx, sid, 0)
	must(t, err)
	eq(t, "blocks after 0", len(blocks), 2)
	eq(t, "block order", blocks[0].Seq, 1)
	eq(t, "block offset", blocks[1].Offset, 200)

	// A second session of the same visitor counts as a new visitor session.
	must(t, s.ApplyFlush(ctx, []store.IngestBlock{batch(p, store.NewID(), "anon-1", 0, now+5000)}, now))
	v, err := s.GetVisitor(ctx, p.ID, r.Visitor.ID)
	must(t, err)
	eq(t, "visitor sessions after second", v.Sessions, 2)
	eq(t, "visitor name kept", *v.Name, "Ada")
	eq(t, "visitor first seen", v.FirstSeen, now)
}

func testRecordings(t *testing.T, s store.Store) {
	org, _ := seedOrg(t, s)
	p := seedProject(t, s, org.ID, "shop")
	now := time.Now().UnixMilli()
	ids := make([]string, 4)
	var blocks []store.IngestBlock
	for i := range ids {
		ids[i] = store.NewID()
		b := batch(p, ids[i], fmt.Sprintf("anon-%d", i%2), 0, now-int64(4-i)*60_000)
		switch i {
		case 0:
			b.LastTs = b.FirstTs + 10*60_000 // long
			b.Device = "Mobile"
		case 1:
			b.Errors = 2
		case 2:
			b.ExternalID, b.Email = "user-7", "seven@acme.dev"
		}
		blocks = append(blocks, b)
	}
	must(t, s.ApplyFlush(ctx, blocks, now))

	page, err := s.ListRecordings(ctx, store.RecordingQuery{ProjectID: p.ID})
	must(t, err)
	eq(t, "total", page.Total, 4)
	eq(t, "newest first", page.Items[0].ID, ids[3])
	eq(t, "friction count", page.Counts.Friction, 1)
	eq(t, "unwatched count", page.Counts.Unwatched, 4)

	must(t, s.SetRecordingFlags(ctx, p.ID, ids[3], ptr(true), ptr(true)))
	must(t, s.SetRecordingFlags(ctx, p.ID, ids[2], nil, ptr(true)))
	cases := []struct {
		q    store.RecordingQuery
		want int
	}{
		{store.RecordingQuery{View: "starred"}, 1},
		{store.RecordingQuery{View: "unwatched"}, 2},
		{store.RecordingQuery{View: "friction"}, 1},
		{store.RecordingQuery{Duration: "long"}, 1},
		{store.RecordingQuery{Duration: "short"}, 3},
		{store.RecordingQuery{Device: "Mobile"}, 1},
		{store.RecordingQuery{Errors: true}, 1},
		{store.RecordingQuery{Q: "SEVEN@acme"}, 2}, // both sessions of that visitor
		{store.RecordingQuery{Q: "100%"}, 0},
		{store.RecordingQuery{Limit: 1, Page: 1}, 4},
	}
	for i, c := range cases {
		c.q.ProjectID = p.ID
		page, err := s.ListRecordings(ctx, c.q)
		must(t, err)
		eq(t, fmt.Sprintf("case %d total", i), page.Total, c.want)
		if c.q.Limit == 1 {
			eq(t, "paged item", page.Items[0].ID, ids[2])
		}
	}
	vpage, _ := s.ListRecordings(ctx, store.RecordingQuery{ProjectID: p.ID, VisitorID: page.Items[0].Visitor.ID})
	eq(t, "visitor filter", vpage.Total, 2)

	r, _ := s.GetRecording(ctx, p.ID, ids[1])
	newer, older, err := s.RecordingNeighbors(ctx, p.ID, r)
	must(t, err)
	eq(t, "newer", newer, ids[2])
	eq(t, "older", older, ids[0])
	r0, _ := s.GetRecording(ctx, p.ID, ids[0])
	_, older, _ = s.RecordingNeighbors(ctx, p.ID, r0)
	eq(t, "oldest has no older", older, "")

	must(t, s.DeleteRecording(ctx, p.ID, ids[0], now))
	if _, err := s.GetRecording(ctx, p.ID, ids[0]); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("deleted recording: %v", err)
	}
	if err := s.SetRecordingFlags(ctx, p.ID, ids[0], ptr(true), nil); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("flag deleted recording: %v", err)
	}
	n, err := s.DeleteRecordings(ctx, p.ID, now-150_000, now)
	must(t, err)
	eq(t, "deleted older", n, 1)
	n, _ = s.DeleteRecordings(ctx, p.ID, 0, now)
	eq(t, "deleted rest", n, 2)
}

func testAggregates(t *testing.T, s store.Store) {
	org, _ := seedOrg(t, s)
	p := seedProject(t, s, org.ID, "shop")
	// Midday, so "today" and "the last 24 hours" cover the same recordings.
	now := time.Now().UTC().Truncate(24 * time.Hour).Add(12 * time.Hour).UnixMilli()
	var blocks []store.IngestBlock
	for i := range 5 {
		b := batch(p, store.NewID(), fmt.Sprintf("anon-%d", i), 0, now-int64(i)*day-60_000)
		b.Path, b.Paths = "/checkout", []string{"/checkout"}
		if i == 1 {
			b.RageClicks = 3
			b.CountryCode, b.Country = "GB", "United Kingdom"
		}
		if i == 2 {
			b.Errors = 1
		}
		blocks = append(blocks, b)
	}
	old := batch(p, store.NewID(), "anon-old", 0, now-10*day)
	blocks = append(blocks, old)
	live := batch(p, store.NewID(), "anon-live", 0, now-500)
	live.LastTs = now
	blocks = append(blocks, live)
	must(t, s.ApplyFlush(ctx, blocks, now))

	stats, err := s.ProjectStats(ctx, []string{p.ID, "empty"}, store.StatsQuery{Now: now, LiveSince: now - 45_000})
	must(t, err)
	st := stats[p.ID]
	eq(t, "recordings", st.Recordings, 7)
	eq(t, "24h", st.Recordings24h, 2)
	eq(t, "live", st.Live, 1)
	eq(t, "storage", st.StorageBytes, 700)
	eq(t, "series len", len(st.Series), 30)
	sum := 0
	for _, n := range st.Series {
		sum += n
	}
	eq(t, "series sum", sum, 7)
	eq(t, "series today", st.Series[29], 2)
	eq(t, "empty project", len(stats["empty"].Series), 30)

	todayStart := now / day * day
	o, err := s.Overview(ctx, store.OverviewQuery{ProjectID: p.ID, From: todayStart - 6*day, To: now + 1, PrevFrom: todayStart - 13*day, TodayFrom: todayStart})
	must(t, err)
	eq(t, "overview recordings", o.Totals.Recordings, 6)
	eq(t, "overview friction", o.Totals.FrictionSessions, 1)
	eq(t, "overview errors", o.Totals.ErrorSessions, 1)
	eq(t, "overview trend", o.Totals.TrendPercent, 500)
	eq(t, "overview days", len(o.Days), 7)
	clean := 0
	for _, d := range o.Days {
		clean += d.Clean
	}
	eq(t, "clean sessions", clean, 4)
	eq(t, "top page", o.TopPages[0].Path, "/checkout")
	eq(t, "top page views", o.TopPages[0].Views, 5)
	eq(t, "top page rage", o.TopPages[0].Rage, 1)
	eq(t, "devices", o.Devices[0].Count, 6)
	eq(t, "countries", o.Countries[0].Code, "NG")
	eq(t, "country name", o.Countries[0].Name, "Nigeria")

	l, err := s.Live(ctx, p.ID, now-45_000, now-5*60_000)
	must(t, err)
	eq(t, "live visitors", l.Visitors, 1)
	eq(t, "active 5m", l.ActiveLast5m, 2)
	eq(t, "live sessions", len(l.Sessions), 1)
	eq(t, "live page", l.Pages[0].Path, "/p0")

	rep, err := s.StorageReport(ctx, []string{p.ID}, now)
	must(t, err)
	eq(t, "storage total", rep.TotalBytes, 700)
	eq(t, "storage recordings", rep.Recordings, 7)
	eq(t, "last 7 days", rep.Ages[0].Bytes, 600)
	eq(t, "8-30 days", rep.Ages[1].Bytes, 100)
	eq(t, "nothing expiring", rep.Ages[1].ExpiringBytes, 0)
	p.RetentionDays = 7
	must(t, s.UpdateProject(ctx, p))
	rep, _ = s.StorageReport(ctx, []string{p.ID}, now)
	eq(t, "expiring", rep.Ages[1].ExpiringBytes, 100)
	eq(t, "next cleanup", rep.NextCleanupFreesBytes, 100)
}

func testVisitors(t *testing.T, s store.Store) {
	org, _ := seedOrg(t, s)
	p := seedProject(t, s, org.ID, "shop")
	now := time.Now().UnixMilli()
	a := batch(p, store.NewID(), "anon-a", 0, now-2*day)
	a.ExternalID, a.Email, a.Name = "user-1", "Ann@acme.dev", "Ann"
	a2 := batch(p, store.NewID(), "anon-a", 0, now-day)
	a2.RageClicks = 2
	b := batch(p, store.NewID(), "anon-b", 0, now)
	must(t, s.ApplyFlush(ctx, []store.IngestBlock{a, a2, b}, now))

	page, err := s.ListVisitors(ctx, store.VisitorQuery{ProjectID: p.ID})
	must(t, err)
	eq(t, "visitors", page.Total, 2)
	eq(t, "identified", page.Counts.Identified, 1)
	eq(t, "anonymous", page.Counts.Anonymous, 1)
	eq(t, "last seen first", page.Items[0].AnonymousID, "anon-b")
	page, _ = s.ListVisitors(ctx, store.VisitorQuery{ProjectID: p.ID, Sort: "sessions"})
	eq(t, "most sessions first", page.Items[0].AnonymousID, "anon-a")
	page, _ = s.ListVisitors(ctx, store.VisitorQuery{ProjectID: p.ID, Kind: "identified"})
	eq(t, "identified list", len(page.Items), 1)
	page, _ = s.ListVisitors(ctx, store.VisitorQuery{ProjectID: p.ID, Q: "ann"})
	eq(t, "search", page.Total, 1)
	ann := page.Items[0]

	stats, activity, err := s.VisitorDetail(ctx, p.ID, ann.ID, now-83*day, 0)
	must(t, err)
	eq(t, "visitor sessions", stats.Sessions, 2)
	eq(t, "visitor rage", stats.RageClicks, 2)
	eq(t, "visitor duration", stats.TotalDurationMs, 2000)
	eq(t, "activity days", len(activity), 84)
	eq(t, "activity today-1", activity[82].Count, 1)
	eq(t, "activity today", activity[83].Date, time.UnixMilli(now).UTC().Format(time.DateOnly))

	for _, q := range []string{ann.ID, "user-1", "ann@ACME.dev"} {
		ids, err := s.FindVisitors(ctx, p.ID, q)
		must(t, err)
		eq(t, "find "+q, len(ids), 1)
	}
	must(t, s.DeleteVisitor(ctx, p.ID, ann.ID, now))
	rec, _ := s.ListRecordings(ctx, store.RecordingQuery{ProjectID: p.ID})
	eq(t, "recordings after visitor delete", rec.Total, 1)
	if err := s.DeleteVisitor(ctx, p.ID, ann.ID, now); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("delete missing visitor: %v", err)
	}
}

func testVisitorPrefix(t *testing.T, s store.Store) {
	org, _ := seedOrg(t, s)
	p := seedProject(t, s, org.ID, "shop")
	other := seedProject(t, s, org.ID, "other")
	now := time.Now().UnixMilli()
	var blocks []store.IngestBlock
	for i, ext := range []string{"ws_1:u1", "ws_1:u2", "ws_12:u1", "WS_1:u3", "wsx1:u4", "ws%1:u5", "ws_1"} {
		b := batch(p, store.NewID(), fmt.Sprintf("anon-%d", i), 0, now)
		b.ExternalID = ext
		blocks = append(blocks, b)
	}
	o := batch(other, store.NewID(), "anon-other", 0, now)
	o.ExternalID = "ws_1:u1"
	blocks = append(blocks, o)
	must(t, s.ApplyFlush(ctx, blocks, now))

	ids, err := s.FindVisitorsByExternalIDPrefix(ctx, p.ID, "ws_1:")
	must(t, err)
	eq(t, "prefix matches", len(ids), 2)
	for _, id := range ids {
		v, err := s.GetVisitor(ctx, p.ID, id)
		must(t, err)
		if v.ExternalID == nil || !strings.HasPrefix(*v.ExternalID, "ws_1:") {
			t.Fatalf("prefix matched %v", v.ExternalID)
		}
	}
	ids, _ = s.FindVisitorsByExternalIDPrefix(ctx, p.ID, "ws%")
	eq(t, "percent is literal", len(ids), 1)
	ids, _ = s.FindVisitorsByExternalIDPrefix(ctx, p.ID, "w_")
	eq(t, "underscore is literal", len(ids), 0)
	ids, _ = s.FindVisitorsByExternalIDPrefix(ctx, p.ID, "ws_12:")
	eq(t, "longer prefix", len(ids), 1)
	ids, _ = s.FindVisitorsByExternalIDPrefix(ctx, other.ID, "ws_1:")
	eq(t, "other project", len(ids), 1)
}

func testWorker(t *testing.T, s store.Store) {
	org, _ := seedOrg(t, s)
	p := seedProject(t, s, org.ID, "shop")
	now := time.Now().UnixMilli()
	sid, idle := store.NewID(), store.NewID()
	must(t, s.ApplyFlush(ctx, []store.IngestBlock{
		batch(p, idle, "anon-1", 0, now-3600_000), batch(p, idle, "anon-1", 1, now-3500_000),
		batch(p, sid, "anon-2", 0, now),
	}, now))

	c, err := s.SealCandidates(ctx, now-1800_000, 10)
	must(t, err)
	eq(t, "candidates", len(c), 1)
	eq(t, "candidate", c[0].ID, idle)
	eq(t, "candidate retention", c[0].RetentionDays, 30)
	eq(t, "candidate blocks", len(c[0].Blocks), 2)

	inUse, err := s.LiveKeysInUse(ctx, []string{"live/f-0.bin", "live/f-1.bin", "live/f-9.bin"})
	must(t, err)
	eq(t, "live keys", len(inUse), 2)

	chunks := []store.Chunk{{Offset: 0, Length: 50, FirstTs: 1, LastTs: 2, Events: 3, FirstSeq: 0, LastSeq: 1}}
	// seq 2 lands while sealing: the session must stay open for it.
	must(t, s.ApplyFlush(ctx, []store.IngestBlock{batch(p, idle, "anon-1", 2, now-3400_000)}, now))
	must(t, s.SealSession(ctx, store.SealResult{SessionID: idle, Key: "sealed/30d/p/a.bin", Chunks: chunks, SizeBytes: 50, LastSeq: 1, UpToSeq: 1}))
	r, _ := s.GetRecording(ctx, p.ID, idle)
	eq(t, "still open", r.Sealed, false)
	eq(t, "sealed key", r.SealedKey, "sealed/30d/p/a.bin")
	eq(t, "chunks", len(r.SealedChunks), 1)
	eq(t, "chunk seq", r.SealedChunks[0].LastSeq, 1)
	left, _ := s.ListBlocks(ctx, idle, -1)
	eq(t, "blocks left", len(left), 1)
	must(t, s.SealSession(ctx, store.SealResult{SessionID: idle, Key: "sealed/30d/p/b.bin", Chunks: chunks, SizeBytes: 60, LastSeq: 2, UpToSeq: 2}))
	r, _ = s.GetRecording(ctx, p.ID, idle)
	eq(t, "sealed", r.Sealed, true)
	eq(t, "size", r.SizeBytes, 60)
	eq(t, "last seq", r.LastSeq, 2)
	c, _ = s.SealCandidates(ctx, now-1800_000, 10)
	eq(t, "no candidates", len(c), 0)

	keys, err := s.SealedKeysInUse(ctx)
	must(t, err)
	eq(t, "sealed keys", len(keys), 1)
	eq(t, "sealed key in use", keys["sealed/30d/p/b.bin"], true)

	// An old starred recording survives retention, an old plain one does not.
	oldStar, oldPlain := store.NewID(), store.NewID()
	must(t, s.ApplyFlush(ctx, []store.IngestBlock{
		batch(p, oldStar, "anon-3", 0, now-40*day), batch(p, oldPlain, "anon-3", 0, now-40*day),
	}, now))
	must(t, s.SetRecordingFlags(ctx, p.ID, oldStar, ptr(true), nil))
	n, bytes, err := s.ExpireSessions(ctx, now)
	must(t, err)
	eq(t, "expired", n, 1)
	eq(t, "expired bytes", bytes, 100)
	must(t, s.DeleteRecording(ctx, p.ID, sid, now))
	purged, err := s.PurgeDeleted(ctx, now)
	must(t, err)
	eq(t, "purged", purged, 2)
	page, _ := s.ListRecordings(ctx, store.RecordingQuery{ProjectID: p.ID})
	eq(t, "left", page.Total, 2)
	ids := []string{page.Items[0].ID, page.Items[1].ID}
	slices.Sort(ids)
	want := []string{idle, oldStar}
	slices.Sort(want)
	eq(t, "survivors", fmt.Sprint(ids), fmt.Sprint(want))
	must(t, s.MaintainPartitions(ctx, now))
}
