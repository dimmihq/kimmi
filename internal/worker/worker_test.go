package worker

import (
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestObjectTimes(t *testing.T) {
	if got := liveObjectTime("live/2026-11-27/host-1-a1b2c3-1795750000000.bin"); got != 1795750000000 {
		t.Fatalf("live time %d", got)
	}
	if got := liveObjectTime("live/2026-11-27/weird.bin"); got != 1<<63-1 {
		t.Fatalf("unreadable live name must count as new, got %d", got)
	}
	id := uuid.Must(uuid.NewV7())
	got := sealedObjectTime("sealed/30d/p/2026-11-27/" + id.String() + ".bin")
	if d := time.Since(got); d < 0 || d > time.Minute {
		t.Fatalf("sealed time %v", got)
	}
	if d := time.Since(sealedObjectTime("sealed/30d/p/x/not-a-uuid.bin")); d > time.Minute {
		t.Fatal("unreadable sealed name must count as new")
	}
}
