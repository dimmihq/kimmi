// Package app wires kimmi's parts together for `kimmi serve` and for the
// end-to-end tests.
package app

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/dimmihq/kimmi/internal/api"
	"github.com/dimmihq/kimmi/internal/auth"
	"github.com/dimmihq/kimmi/internal/blob"
	"github.com/dimmihq/kimmi/internal/bootstrap"
	"github.com/dimmihq/kimmi/internal/config"
	"github.com/dimmihq/kimmi/internal/guard"
	"github.com/dimmihq/kimmi/internal/ingest"
	"github.com/dimmihq/kimmi/internal/notify"
	"github.com/dimmihq/kimmi/internal/replay"
	"github.com/dimmihq/kimmi/internal/store/sqlstore"
	"github.com/dimmihq/kimmi/internal/webui"
	"github.com/dimmihq/kimmi/internal/worker"
)

// cacheRefresh is how often the ingest key cache reloads from the database.
const cacheRefresh = 5 * time.Second

// App is a running kimmi node.
type App struct {
	Config  config.Config
	Store   *sqlstore.DB
	Blob    blob.Store
	Cache   *ingest.Cache
	Flusher *ingest.Flusher
	Worker  *worker.Worker
	Notify  *notify.Notifier
	log     *slog.Logger
	handler http.Handler
}

// New opens storage and the database (running migrations) and builds the
// HTTP handler for the configured roles.
func New(ctx context.Context, cfg config.Config, version, commit string, log *slog.Logger) (*App, error) {
	db, err := sqlstore.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return nil, err
	}
	b, err := openBlob(ctx, cfg)
	if err != nil {
		db.Close()
		return nil, err
	}
	if err := Bootstrap(ctx, db, cfg, log); err != nil {
		db.Close()
		return nil, err
	}
	codec, err := replay.NewCodec()
	if err != nil {
		db.Close()
		return nil, err
	}
	source := &replay.Source{Blob: b, Codec: codec, Log: log}
	a := &App{Config: cfg, Store: db, Blob: b, log: log,
		Worker: &worker.Worker{Store: db, Blob: b, Source: source, Log: log}}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("ok\n")) })
	mux.HandleFunc("/i/", http.NotFound)

	// One notifier per node: ingest raises alerts from incoming data, the
	// worker from the clock, the API from the test and "send now" buttons.
	a.Notify = notify.New(db, log, cfg.PublicURL, version, func(id string) (notify.Project, bool) {
		if a.Cache == nil {
			return notify.Project{}, false
		}
		p, ok := a.Cache.ByID(id)
		if !ok {
			return notify.Project{}, false
		}
		return notify.Project{ID: p.ID, Name: p.Name, Timezone: p.Timezone, Alerts: p.Settings.Alerts}, true
	})
	a.Worker.Notify = a.Notify
	if cfg.TestHooks {
		a.Worker.AlertEvery = 2 * time.Second
		log.Warn("KIMMI_TEST_HOOKS is on: this instance trusts clients about time; never use it in production")
	}

	proxies := guard.Proxies{Trusted: cfg.TrustedProxies}
	stats := &ingest.Stats{}
	if cfg.Has(config.RoleIngest) {
		a.Cache = ingest.NewCache(db, log)
		if err := a.Cache.Load(ctx); err != nil {
			db.Close()
			return nil, err
		}
		a.Flusher = ingest.NewFlusher(b, db, nodeName(), stats, log,
			ingest.Limits{Buffer: cfg.IngestBuffer, Project: cfg.IngestProjectBuffer})
		a.Flusher.OnHits = a.Notify.Hits
		(&ingest.Handler{Cache: a.Cache, Flusher: a.Flusher, Stats: stats, Proxies: proxies,
			Limit: guard.NewLimiter(cfg.IngestRate, cfg.IngestBurst), MaxReading: cfg.IngestBuffer,
			Salts: &ingest.Salts{Store: db}, Feedback: db, OnFeedback: a.Notify.Feedback, TrustClock: cfg.TestHooks}).Register(mux)
	}
	if cfg.Has(config.RoleAPI) {
		svc := &api.API{Store: db, Blob: b, Source: source, Worker: a.Worker, Signer: auth.NewSigner(cfg.Secret),
			Config: cfg, Log: log, Projects: invalidator{a.Cache}, Version: version, Commit: commit, StartedAt: time.Now(),
			Proxies: proxies, AuthLimit: guard.NewLimiter(cfg.AuthRate/60, cfg.AuthBurst), Notify: a.Notify}
		if a.Flusher != nil {
			svc.Ingest = func() api.IngestHealth {
				return api.IngestHealth{Snapshot: stats.Snapshot(time.Now()), BufferedBytes: a.Flusher.Buffered()}
			}
		}
		mux.Handle("/api/", guard.Dashboard(svc.Handler(), cfg.Secure()))
		mux.Handle("/mcp", svc.Handler())
		mux.Handle("/", guard.Dashboard(webui.Handler(), cfg.Secure()))
	}
	mux.Handle("GET /kimmi.js", webui.Handler())
	mux.Handle("GET /kimmi-feedback.js", webui.Handler())
	a.handler = guard.Transport(mux, cfg.Secure())
	return a, nil
}

// Bootstrap applies KIMMI_OWNER and KIMMI_BOOTSTRAP. Concurrent starters
// on PostgreSQL take turns, so two nodes never create two organisations.
func Bootstrap(ctx context.Context, db *sqlstore.DB, cfg config.Config, log *slog.Logger) error {
	var file bootstrap.File
	if cfg.Bootstrap != "" {
		f, err := bootstrap.Load(cfg.Bootstrap)
		if err != nil {
			return err
		}
		file = f
	}
	if cfg.OwnerEmail == "" && len(file.Projects) == 0 {
		return nil
	}
	return db.Exclusive(ctx, func() error {
		created, err := bootstrap.Owner(ctx, db, cfg.Org, cfg.OwnerEmail, cfg.OwnerPassword)
		if err != nil {
			return err
		}
		if created {
			log.Info("created the owner from KIMMI_OWNER")
		}
		res, err := bootstrap.Apply(ctx, db, cfg.Org, file)
		if err != nil {
			return err
		}
		if len(res.Created) > 0 || len(res.Kept) > 0 {
			log.Info("applied KIMMI_BOOTSTRAP", "created", res.Created, "unchanged", res.Kept)
		}
		return nil
	})
}

func openBlob(ctx context.Context, cfg config.Config) (blob.Store, error) {
	if cfg.Storage == "s3" {
		return blob.NewS3(ctx, blob.S3Config{Endpoint: cfg.S3.Endpoint, Bucket: cfg.S3.Bucket, Region: cfg.S3.Region,
			AccessKey: cfg.S3.AccessKey, SecretKey: cfg.S3.SecretKey})
	}
	return blob.NewLocal(cfg.StoragePath)
}

// invalidator forwards project changes to the ingest cache when this node has one.
type invalidator struct{ cache *ingest.Cache }

func (i invalidator) Invalidate(ctx context.Context) {
	if i.cache != nil {
		i.cache.Invalidate(ctx)
	}
}

// nodeName names this process in live object keys: the host plus a random
// suffix, so two processes on one host never collide.
func nodeName() string {
	host, _ := os.Hostname()
	host = strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-' {
			return r
		}
		if r >= 'A' && r <= 'Z' {
			return r + 32
		}
		return -1
	}, host)
	if len(host) > 24 {
		host = host[:24]
	}
	suffix := make([]byte, 3)
	_, _ = rand.Read(suffix)
	if host == "" {
		host = "node"
	}
	return host + "-" + hex.EncodeToString(suffix)
}

// Handler is the node's HTTP handler.
func (a *App) Handler() http.Handler { return a.handler }

// Run serves on ln until ctx ends, then shuts down in order: stop taking
// requests, flush buffered batches, stop background jobs, close the database.
func (a *App) Run(ctx context.Context, ln net.Listener) error {
	jobs, stopJobs := context.WithCancel(context.WithoutCancel(ctx))
	var wg sync.WaitGroup
	if a.Cache != nil {
		wg.Go(func() { a.Cache.Run(jobs, cacheRefresh) })
		wg.Go(func() { a.Flusher.Run(jobs, a.Config.FlushInterval) })
	}
	if a.Config.Has(config.RoleWorker) {
		wg.Go(func() { a.Worker.Run(jobs, a.Config.SessionIdle) })
	}

	if a.Config.DebugAddr != "" {
		dbg, err := startDebug(a.Config.DebugAddr, a.log)
		if err != nil {
			stopJobs()
			wg.Wait()
			a.Store.Close()
			return err
		}
		defer dbg.Close()
	}
	wg.Go(func() { a.Notify.Run(jobs) })
	wg.Go(func() { trimMemory(jobs, a.log) })

	srv := &http.Server{Handler: a.handler, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: time.Minute,
		MaxHeaderBytes: 64 << 10}
	served := make(chan error, 1)
	go func() { served <- srv.Serve(ln) }()
	a.log.Info("kimmi is listening", "addr", ln.Addr().String(), "roles", a.Config.Roles, "public_url", a.Config.PublicURL)

	var err error
	select {
	case err = <-served:
	case <-ctx.Done():
		a.log.Info("shutting down")
		shutdown, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		err = srv.Shutdown(shutdown)
		cancel()
	}
	if errors.Is(err, http.ErrServerClosed) {
		err = nil
	}
	stopJobs() // the flusher writes what it still holds before returning
	wg.Wait()
	if cerr := a.Store.Close(); cerr != nil && err == nil {
		err = fmt.Errorf("close database: %w", cerr)
	}
	return err
}

// Close releases the database without serving; for callers that never Run.
func (a *App) Close() error { return a.Store.Close() }
