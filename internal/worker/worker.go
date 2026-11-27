// Package worker runs kimmi's background jobs: sealing idle recordings,
// collecting unused objects, enforcing retention and keeping PostgreSQL
// partitions ahead of time. Run a single worker per instance.
package worker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/dimmihq/kimmi/internal/blob"
	"github.com/dimmihq/kimmi/internal/notify"
	"github.com/dimmihq/kimmi/internal/replay"
	"github.com/dimmihq/kimmi/internal/settings"
	"github.com/dimmihq/kimmi/internal/store"
)

const (
	sealBatch = 500
	// maxObjectSize caps a sealed object, which is built in memory: past it
	// the sealer uploads and starts another object.
	maxObjectSize = 8 << 20
	// Objects younger than these may belong to a flush or seal whose rows
	// are not committed yet.
	liveGrace   = 10 * time.Minute
	sealedGrace = time.Hour
)

// Store is the part of store.Store the worker uses.
type Store interface {
	SealCandidates(ctx context.Context, idleBefore int64, limit int) ([]store.SealCandidate, error)
	SealSession(ctx context.Context, r store.SealResult) error
	LiveKeysInUse(ctx context.Context, keys []string) (map[string]bool, error)
	SealedKeysInUse(ctx context.Context) (map[string]bool, error)
	ExpireSessions(ctx context.Context, now int64) (int, int64, error)
	PurgeDeleted(ctx context.Context, now int64) (int, error)
	MaintainPartitions(ctx context.Context, now int64) error
	ListAllProjects(ctx context.Context) ([]store.Project, error)
	DeleteAnalyticsBefore(ctx context.Context, projectID string, before int64) (int, error)
}

// Worker holds the jobs' dependencies.
type Worker struct {
	Store  Store
	Blob   blob.Store
	Source *replay.Source
	Log    *slog.Logger
	// Notify, when set, gets the projects every AlertEvery (5 minutes when
	// zero) for the alerts that follow the clock.
	Notify     *notify.Notifier
	AlertEvery time.Duration

	cleaning sync.Mutex
	sealing  sync.Mutex // one sealing run at a time, so its memory is bounded

	mu       sync.Mutex
	lastSeal time.Time
	sealErr  error
}

// Seal packs every recording idle for longer than idle into sealed objects
// and returns how many it sealed.
func (w *Worker) Seal(ctx context.Context, idle time.Duration) (int, error) {
	w.sealing.Lock()
	defer w.sealing.Unlock()
	total := 0
	for {
		n, err := w.sealOnce(ctx, idle)
		total += n
		w.mu.Lock()
		w.lastSeal, w.sealErr = time.Now(), err
		w.mu.Unlock()
		if err != nil || n < sealBatch {
			return total, err
		}
	}
}

func (w *Worker) sealOnce(ctx context.Context, idle time.Duration) (int, error) {
	cands, err := w.Store.SealCandidates(ctx, time.Now().Add(-idle).UnixMilli(), sealBatch)
	if err != nil {
		return 0, err
	}
	byProject := map[string][]store.SealCandidate{}
	var order []string
	for _, c := range cands {
		if _, seen := byProject[c.ProjectID]; !seen {
			order = append(order, c.ProjectID)
		}
		byProject[c.ProjectID] = append(byProject[c.ProjectID], c)
	}
	sealed := 0
	for _, pid := range order {
		n, err := w.sealProject(ctx, byProject[pid])
		sealed += n
		if err != nil {
			return sealed, err
		}
	}
	return sealed, nil
}

// sealProject packs recordings of one project into as few objects as the
// size cap allows.
func (w *Worker) sealProject(ctx context.Context, cands []store.SealCandidate) (int, error) {
	packer := replay.NewPacker(w.Source.Codec)
	var results []store.SealResult
	sealed := 0
	commit := func() error {
		key := ""
		if packer.Len() > 0 {
			c := cands[0]
			key = fmt.Sprintf("sealed/%dd/%s/%s/%s.bin", c.RetentionDays, c.ProjectID,
				time.Now().UTC().Format(time.DateOnly), uuid.Must(uuid.NewV7()))
			if err := w.Blob.Put(ctx, key, packer.Bytes()); err != nil {
				return err
			}
		}
		for _, r := range results {
			if len(r.Chunks) > 0 {
				r.Key = key
			}
			if err := w.Store.SealSession(ctx, r); err != nil {
				return err
			}
			sealed++
		}
		packer.Reset()
		results = nil
		return nil
	}
	for _, c := range cands {
		r, err := w.pack(ctx, packer, c)
		if err != nil {
			return sealed, err
		}
		results = append(results, r)
		if packer.Len() >= maxObjectSize {
			if err := commit(); err != nil {
				return sealed, err
			}
		}
	}
	return sealed, commit()
}

func (w *Worker) pack(ctx context.Context, p *replay.Packer, c store.SealCandidate) (store.SealResult, error) {
	r := store.SealResult{SessionID: c.ID, UpToSeq: -1, LastSeq: -1}
	for _, ch := range c.SealedChunks {
		raw, err := w.Source.Chunk(ctx, c.SealedKey, ch)
		if err != nil {
			return r, fmt.Errorf("reseal %s: %w", c.ID, err)
		}
		p.AddChunk(raw, ch)
		r.LastSeq = max(r.LastSeq, ch.LastSeq)
	}
	for _, b := range c.Blocks {
		r.UpToSeq = max(r.UpToSeq, b.Seq)
		raw, err := w.Source.BlockRaw(ctx, b)
		if err != nil {
			if errors.Is(err, context.Canceled) {
				return r, err
			}
			w.Log.Warn("dropping unreadable block while sealing", "err", err)
			continue
		}
		p.BeginBlock(replay.GzipSize(raw))
		added := 0
		err = w.Source.Codec.ScanGzip(raw, func(ev []byte) error {
			var head struct {
				Timestamp int64 `json:"timestamp"`
			}
			_ = json.Unmarshal(ev, &head) // ev is valid JSON; a timestamp of another type reads as 0
			p.AddEvent(b.Seq, ev, head.Timestamp)
			added++
			return nil
		})
		p.EndBlock()
		if err != nil {
			w.Log.Warn("block is damaged; keeping the events before the damage", "session", b.SessionID, "seq", b.Seq,
				"kept", added, "err", err)
		}
		if added > 0 {
			r.LastSeq = max(r.LastSeq, b.Seq)
		}
	}
	r.Chunks = p.End()
	for _, ch := range r.Chunks {
		r.SizeBytes += ch.Length
	}
	return r, nil
}

// CollectLive deletes live objects no block points to any more.
func (w *Worker) CollectLive(ctx context.Context) (deleted int, freed int64, err error) {
	cutoff := time.Now().Add(-liveGrace).UnixMilli()
	var batch []blob.Object
	sweep := func() error {
		keys := make([]string, len(batch))
		for i, o := range batch {
			keys[i] = o.Key
		}
		inUse, err := w.Store.LiveKeysInUse(ctx, keys)
		if err != nil {
			return err
		}
		for _, o := range batch {
			if !inUse[o.Key] {
				if err := w.Blob.Delete(ctx, o.Key); err != nil {
					return err
				}
				deleted++
				freed += o.Size
			}
		}
		batch = batch[:0]
		return nil
	}
	for o, err := range w.Blob.List(ctx, "live/") {
		if err != nil {
			return deleted, freed, err
		}
		if liveObjectTime(o.Key) >= cutoff {
			continue
		}
		if batch = append(batch, o); len(batch) == 500 {
			if err := sweep(); err != nil {
				return deleted, freed, err
			}
		}
	}
	return deleted, freed, sweep()
}

// liveObjectTime reads the unix-ms stamp of live/{day}/{node}-{ms}.bin; an
// unreadable name counts as new, so it is never collected by mistake.
func liveObjectTime(key string) int64 {
	name := strings.TrimSuffix(path.Base(key), ".bin")
	i := strings.LastIndexByte(name, '-')
	ms, err := strconv.ParseInt(name[i+1:], 10, 64)
	if i < 0 || err != nil {
		return 1<<63 - 1
	}
	return ms
}

// sealedObjectTime reads the time inside the UUIDv7 name of a sealed object.
func sealedObjectTime(key string) time.Time {
	id, err := uuid.Parse(strings.TrimSuffix(path.Base(key), ".bin"))
	if err != nil || id.Version() != 7 {
		return time.Now()
	}
	sec, nsec := id.Time().UnixTime()
	return time.Unix(sec, nsec)
}

// CollectSealed deletes sealed objects no recording points to any more.
func (w *Worker) CollectSealed(ctx context.Context) (deleted int, freed int64, err error) {
	inUse, err := w.Store.SealedKeysInUse(ctx)
	if err != nil {
		return 0, 0, err
	}
	cutoff := time.Now().Add(-sealedGrace)
	for o, err := range w.Blob.List(ctx, "sealed/") {
		if err != nil {
			return deleted, freed, err
		}
		if inUse[o.Key] || sealedObjectTime(o.Key).After(cutoff) {
			continue
		}
		if err := w.Blob.Delete(ctx, o.Key); err != nil {
			return deleted, freed, err
		}
		deleted++
		freed += o.Size
	}
	return deleted, freed, nil
}

// CleanupResult is what a retention run removed.
type CleanupResult struct {
	FreedBytes int64 `json:"freedBytes"`
	Deleted    int   `json:"deleted"`
}

// Cleanup enforces retention: expired recordings are deleted, deleted
// recordings purged, and objects nothing points to any more removed.
func (w *Worker) Cleanup(ctx context.Context) (CleanupResult, error) {
	w.cleaning.Lock()
	defer w.cleaning.Unlock()
	var res CleanupResult
	now := time.Now().UnixMilli()
	if _, _, err := w.Store.ExpireSessions(ctx, now); err != nil {
		return res, err
	}
	n, err := w.Store.PurgeDeleted(ctx, now)
	if err != nil {
		return res, err
	}
	res.Deleted = n
	if err := w.expireAnalytics(ctx, now); err != nil {
		return res, err
	}
	_, freed, err := w.CollectSealed(ctx)
	res.FreedBytes += freed
	if err != nil {
		return res, fmt.Errorf("collect sealed objects: %w", err)
	}
	_, freed, err = w.CollectLive(ctx)
	res.FreedBytes += freed
	if err != nil {
		return res, fmt.Errorf("collect live objects: %w", err)
	}
	return res, nil
}

// expireAnalytics removes visits, events and feedback older than each
// project's analytics retention.
func (w *Worker) expireAnalytics(ctx context.Context, now int64) error {
	projects, err := w.Store.ListAllProjects(ctx)
	if err != nil {
		return err
	}
	for _, p := range projects {
		days := settings.Decode(p.Settings, p.RetentionDays, p.KeepStarred).Analytics.RetentionDays
		if _, err := w.Store.DeleteAnalyticsBefore(ctx, p.ID, now-int64(days)*store.DayMs); err != nil {
			return fmt.Errorf("expire analytics of %s: %w", p.ID, err)
		}
	}
	return nil
}

// alerts hands the projects to the notifier.
func (w *Worker) alerts(ctx context.Context) {
	projects, err := w.Store.ListAllProjects(ctx)
	if err != nil {
		w.Log.Error("alerts: list projects", "err", err)
		return
	}
	list := make([]notify.Project, 0, len(projects))
	for _, p := range projects {
		// The digest and the silence alert are about visits: a project
		// that does not count them gets neither.
		if set := settings.Decode(p.Settings, p.RetentionDays, p.KeepStarred); set.Analytics.Enabled {
			list = append(list, notify.Project{ID: p.ID, Name: p.Name, Timezone: p.Timezone, Alerts: set.Alerts})
		}
	}
	w.Notify.Periodic(ctx, list, w.Notify.Now())
}

// LastSeal reports when sealing last ran and how it went.
func (w *Worker) LastSeal() (time.Time, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.lastSeal, w.sealErr
}

// Run schedules the jobs until ctx ends.
func (w *Worker) Run(ctx context.Context, idle time.Duration) {
	seal := time.NewTicker(15 * time.Second)
	collect := time.NewTicker(5 * time.Minute)
	partitions := time.NewTicker(time.Hour)
	cleanup := time.NewTimer(time.Minute)
	every := w.AlertEvery
	if every <= 0 {
		every = 5 * time.Minute
	}
	alerts := time.NewTicker(every)
	defer alerts.Stop()
	defer seal.Stop()
	defer collect.Stop()
	defer partitions.Stop()
	defer cleanup.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-alerts.C:
			if w.Notify != nil {
				w.alerts(ctx)
			}
		case <-seal.C:
			if n, err := w.Seal(ctx, idle); err != nil {
				w.Log.Error("seal recordings", "err", err, "sealed", n)
			} else if n > 0 {
				w.Log.Info("sealed recordings", "count", n)
			}
		case <-collect.C:
			if n, _, err := w.CollectLive(ctx); err != nil {
				w.Log.Error("collect live objects", "err", err)
			} else if n > 0 {
				w.Log.Info("collected live objects", "count", n)
			}
		case <-partitions.C:
			if err := w.Store.MaintainPartitions(ctx, time.Now().UnixMilli()); err != nil {
				w.Log.Error("maintain partitions", "err", err)
			}
		case <-cleanup.C:
			if res, err := w.Cleanup(ctx); err != nil {
				w.Log.Error("retention cleanup", "err", err)
			} else {
				w.Log.Info("retention cleanup", "deleted", res.Deleted, "freedBytes", res.FreedBytes)
			}
			cleanup.Reset(24 * time.Hour)
		}
	}
}
