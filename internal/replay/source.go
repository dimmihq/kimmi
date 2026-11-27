package replay

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/dimmihq/kimmi/internal/blob"
	"github.com/dimmihq/kimmi/internal/store"
)

// Source reads recordings out of blob storage.
type Source struct {
	Blob  blob.Store
	Codec *Codec
	Log   *slog.Logger
}

// BlockRaw returns the stored (gzip) bytes of a live block.
func (s *Source) BlockRaw(ctx context.Context, b store.Block) ([]byte, error) {
	raw, err := s.Blob.Get(ctx, b.FileKey, b.Offset, b.Length)
	if err != nil {
		return nil, fmt.Errorf("block %s/%d: %w", b.SessionID, b.Seq, err)
	}
	return raw, nil
}

// Chunk returns the compressed bytes of a sealed chunk.
func (s *Source) Chunk(ctx context.Context, key string, c store.Chunk) ([]byte, error) {
	raw, err := s.Blob.Get(ctx, key, c.Offset, c.Length)
	if err != nil {
		return nil, fmt.Errorf("chunk %s@%d: %w", key, c.Offset, err)
	}
	return raw, nil
}

// WriteEvents streams the recording's events with seq above after: sealed
// chunks first, then live blocks. A sealed chunk holding seq after and later
// ones is sent whole. Damaged blocks are logged and skipped so one bad batch
// does not hide the rest of a recording.
func (s *Source) WriteEvents(ctx context.Context, aw *ArrayWriter, r store.Recording, blocks []store.Block, after int64) error {
	for _, c := range r.SealedChunks {
		if c.LastSeq <= after {
			continue
		}
		raw, err := s.Chunk(ctx, r.SealedKey, c)
		if err != nil {
			return err
		}
		array, err := s.Codec.DecodeChunk(raw)
		if err != nil {
			return fmt.Errorf("recording %s: %w", r.ID, err)
		}
		if err := aw.WriteArray(array); err != nil {
			return fmt.Errorf("recording %s: %w", r.ID, err)
		}
	}
	for _, b := range blocks {
		raw, err := s.BlockRaw(ctx, b)
		if err == nil {
			// The SDK's bytes are stored unchecked: each event is validated
			// as it streams, and a damaged block keeps its sound start.
			err = s.Codec.ScanGzip(raw, aw.WriteElement)
		}
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			s.Log.Warn("skipping unreadable block", "session", b.SessionID, "seq", b.Seq, "err", err)
		}
	}
	return nil
}
