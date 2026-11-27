// Package blob stores recording bytes on local disk or S3-compatible storage.
package blob

import (
	"bytes"
	"context"
	"errors"
	"io"
	"iter"
)

// ErrNotFound is returned by Get for a key that does not exist.
var ErrNotFound = errors.New("blob not found")

// Object is one stored object as List sees it.
type Object struct {
	Key  string
	Size int64
}

// Store is the interface both drivers implement. Keys use forward slashes.
type Store interface {
	Put(ctx context.Context, key string, data []byte) error
	// PutReader stores exactly size bytes read from r, without holding the
	// object in memory. An r that is also an io.ReadSeeker may be read again
	// when the upload is retried.
	PutReader(ctx context.Context, key string, r io.Reader, size int64) error
	// Get reads length bytes from offset; a negative length reads to the end.
	Get(ctx context.Context, key string, offset, length int64) ([]byte, error)
	// Delete removes key; a missing key is not an error.
	Delete(ctx context.Context, key string) error
	List(ctx context.Context, prefix string) iter.Seq2[Object, error]
	Driver() string
	Location() string
}

// putBytes is Put in terms of PutReader.
func putBytes(ctx context.Context, s Store, key string, data []byte) error {
	return s.PutReader(ctx, key, bytes.NewReader(data), int64(len(data)))
}
