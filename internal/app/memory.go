package app

import (
	"context"
	"log/slog"
	"net"
	"net/http"
	"net/http/pprof"
	"runtime"
	"runtime/debug"
	"time"
)

// SetMemoryLimit applies the soft memory limit: GOMEMLIMIT when set (the
// runtime reads it itself), otherwise KIMMI_MEMORY_LIMIT. Near the limit
// the garbage collector works harder and returns memory to the OS sooner.
func SetMemoryLimit(limit int64, log *slog.Logger) {
	if limit > 0 {
		debug.SetMemoryLimit(limit)
	}
	log.Info("memory limit", "bytes", debug.SetMemoryLimit(-1))
}

// trimEvery is how often trimMemory looks for memory to give back.
const trimEvery = 15 * time.Second

// trimMemory returns freed heap to the operating system once the process
// has gone quiet. The runtime does this by itself, but only slowly; after
// a burst, a node would otherwise keep its peak for many minutes.
func trimMemory(ctx context.Context, log *slog.Logger) {
	t := time.NewTicker(trimEvery)
	defer t.Stop()
	var last runtime.MemStats
	runtime.ReadMemStats(&last)
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		var m runtime.MemStats
		runtime.ReadMemStats(&m)
		allocated := m.TotalAlloc - last.TotalAlloc
		last = m
		// Quiet: less than 4 MiB allocated a second. Worth it: at least
		// 8 MiB of heap the OS could have back.
		quiet := allocated < 4<<20*uint64(trimEvery/time.Second)
		if quiet && m.HeapIdle-m.HeapReleased >= 8<<20 {
			debug.FreeOSMemory()
			runtime.ReadMemStats(&last)
		}
	}
}

// startDebug serves net/http/pprof on its own listener, never the public one.
func startDebug(addr string, log *slog.Logger) (*http.Server, error) {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, err
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/debug/pprof/", pprof.Index)
	mux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
	mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
	mux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
	mux.HandleFunc("/debug/pprof/trace", pprof.Trace)
	srv := &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go srv.Serve(ln)
	log.Warn("debug server with pprof is listening; keep it off the public network", "addr", ln.Addr().String())
	return srv, nil
}
