package blob

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"iter"
	"os"
	"path/filepath"
	"strings"
)

// Local keeps objects as files under a root folder.
type Local struct{ root string }

// NewLocal creates the root folder when needed.
func NewLocal(root string) (*Local, error) {
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, fmt.Errorf("storage path %q: %w", root, err)
	}
	if err := os.MkdirAll(abs, 0o755); err != nil {
		return nil, fmt.Errorf("create storage folder: %w", err)
	}
	return &Local{root: abs}, nil
}

func (l *Local) path(key string) (string, error) {
	if key == "" || strings.HasPrefix(key, "/") || strings.Contains(key, "..") || strings.Contains(key, `\`) {
		return "", fmt.Errorf("invalid blob key %q", key)
	}
	return filepath.Join(l.root, filepath.FromSlash(key)), nil
}

// Put writes to a temporary file and renames it so readers never see half an object.
func (l *Local) Put(ctx context.Context, key string, data []byte) error {
	return putBytes(ctx, l, key, data)
}

// PutReader streams r into a temporary file and renames it into place.
func (l *Local) PutReader(_ context.Context, key string, r io.Reader, size int64) error {
	p, err := l.path(key)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return fmt.Errorf("put %s: %w", key, err)
	}
	tmp, err := os.CreateTemp(filepath.Dir(p), ".tmp-*")
	if err != nil {
		return fmt.Errorf("put %s: %w", key, err)
	}
	fail := func(err error) error {
		tmp.Close()
		os.Remove(tmp.Name())
		return fmt.Errorf("put %s: %w", key, err)
	}
	n, err := io.Copy(tmp, io.LimitReader(r, size))
	if err != nil {
		return fail(err)
	}
	if n != size {
		return fail(fmt.Errorf("short object: %d of %d bytes", n, size))
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmp.Name())
		return fmt.Errorf("put %s: %w", key, err)
	}
	if err := os.Rename(tmp.Name(), p); err != nil {
		os.Remove(tmp.Name())
		return fmt.Errorf("put %s: %w", key, err)
	}
	return nil
}

func (l *Local) Get(_ context.Context, key string, offset, length int64) ([]byte, error) {
	p, err := l.path(key)
	if err != nil {
		return nil, err
	}
	f, err := os.Open(p)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("get %s: %w", key, err)
	}
	defer f.Close()
	if length < 0 {
		st, err := f.Stat()
		if err != nil {
			return nil, fmt.Errorf("get %s: %w", key, err)
		}
		length = max(st.Size()-offset, 0)
	}
	buf := make([]byte, length)
	if _, err := f.ReadAt(buf, offset); err != nil && !(errors.Is(err, io.EOF) && length == 0) {
		return nil, fmt.Errorf("get %s [%d+%d]: %w", key, offset, length, err)
	}
	return buf, nil
}

func (l *Local) Delete(_ context.Context, key string) error {
	p, err := l.path(key)
	if err != nil {
		return err
	}
	if err := os.Remove(p); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("delete %s: %w", key, err)
	}
	return nil
}

func (l *Local) List(ctx context.Context, prefix string) iter.Seq2[Object, error] {
	return func(yield func(Object, error) bool) {
		err := filepath.WalkDir(l.root, func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if err := ctx.Err(); err != nil {
				return err
			}
			rel, _ := filepath.Rel(l.root, p)
			key := filepath.ToSlash(rel)
			if d.IsDir() {
				if key != "." && !strings.HasPrefix(key+"/", prefix) && !strings.HasPrefix(prefix, key+"/") {
					return fs.SkipDir
				}
				return nil
			}
			if !strings.HasPrefix(key, prefix) || strings.HasPrefix(d.Name(), ".tmp-") {
				return nil
			}
			info, err := d.Info()
			if err != nil {
				return err
			}
			if !yield(Object{Key: key, Size: info.Size()}, nil) {
				return fs.SkipAll
			}
			return nil
		})
		if err != nil {
			yield(Object{}, fmt.Errorf("list %s: %w", prefix, err))
		}
	}
}

func (l *Local) Driver() string   { return "local" }
func (l *Local) Location() string { return l.root }
