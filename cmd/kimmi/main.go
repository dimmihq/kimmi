// Command kimmi is the kimmi server: self-hosted session replay in one binary.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/dimmihq/kimmi/internal/app"
	"github.com/dimmihq/kimmi/internal/config"
	"github.com/dimmihq/kimmi/internal/loadgen"
)

// Set with -ldflags "-X main.version=... -X main.commit=...".
var (
	version = "dev"
	commit  = "none"
)

const usage = `kimmi: self-hosted session replay

Usage:
  kimmi serve      run the server (configured with KIMMI_* environment variables)
  kimmi loadgen    send synthetic recordings to a server (kimmi loadgen -h for flags)
  kimmi admin      manage the instance from the database (kimmi admin -h)
  kimmi version    print the version
`

func main() {
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "serve":
		err = serve()
	case "loadgen":
		err = runLoadgen(os.Args[2:])
	case "admin":
		err = runAdmin(os.Args[2:], os.Stdout)
	case "version", "--version", "-v":
		fmt.Printf("kimmi %s (%s)\n", version, commit)
	case "help", "-h", "--help":
		fmt.Print(usage)
	default:
		fmt.Fprintf(os.Stderr, "kimmi: unknown command %q\n\n%s", os.Args[1], usage)
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "kimmi:", err)
		os.Exit(1)
	}
}

func serve() error {
	log := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	cfg, err := config.Load(os.Getenv)
	if err != nil {
		return err
	}
	app.SetMemoryLimit(cfg.MemoryLimit, log)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	a, err := app.New(ctx, cfg, version, commit, log)
	if err != nil {
		return err
	}
	ln, err := net.Listen("tcp", cfg.HTTPAddr)
	if err != nil {
		a.Close()
		return fmt.Errorf("listen on %s: %w", cfg.HTTPAddr, err)
	}
	return a.Run(ctx, ln)
}

func runLoadgen(args []string) error {
	fs := flag.NewFlagSet("loadgen", flag.ExitOnError)
	var o loadgen.Options
	fs.StringVar(&o.Host, "host", "http://localhost:8700", "server address")
	fs.StringVar(&o.Key, "key", "", "project public key (km_pub_...)")
	fs.IntVar(&o.Sessions, "sessions", 100, "total sessions to send")
	fs.IntVar(&o.Concurrency, "concurrency", 20, "sessions sending at once")
	fs.IntVar(&o.Batches, "batches", 10, "batches per session")
	fs.DurationVar(&o.Interval, "interval", 2*time.Second, "pause between two batches of one session")
	fs.DurationVar(&o.Duration, "duration", 0, "stop after this long (0: when every session is sent)")
	_ = fs.Parse(args) // ExitOnError: Parse exits by itself
	if o.Key == "" {
		return errors.New("loadgen: --key is required")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	report, err := loadgen.Run(ctx, o, os.Stdout)
	if err != nil {
		return err
	}
	fmt.Print(report)
	return nil
}
