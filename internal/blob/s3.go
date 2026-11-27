package blob

import (
	"context"
	"errors"
	"fmt"
	"io"
	"iter"
	"net/url"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// S3Config locates a bucket on any S3-compatible service.
type S3Config struct {
	Endpoint, Bucket, Region, AccessKey, SecretKey string
}

// S3 keeps objects in one bucket, always addressed path-style.
type S3 struct {
	client *minio.Client
	bucket string
	where  string
}

// NewS3 connects and creates the bucket when it does not exist yet.
func NewS3(ctx context.Context, c S3Config) (*S3, error) {
	host, secure := c.Endpoint, true
	if u, err := url.Parse(c.Endpoint); err == nil && u.Host != "" {
		host, secure = u.Host, u.Scheme == "https"
	}
	client, err := minio.New(host, &minio.Options{
		Creds:        credentials.NewStaticV4(c.AccessKey, c.SecretKey, ""),
		Secure:       secure,
		Region:       c.Region,
		BucketLookup: minio.BucketLookupPath,
	})
	if err != nil {
		return nil, fmt.Errorf("s3 client: %w", err)
	}
	exists, err := client.BucketExists(ctx, c.Bucket)
	if err != nil {
		return nil, fmt.Errorf("s3 bucket %s at %s: %w", c.Bucket, c.Endpoint, err)
	}
	if !exists {
		if err := client.MakeBucket(ctx, c.Bucket, minio.MakeBucketOptions{Region: c.Region}); err != nil {
			return nil, fmt.Errorf("create s3 bucket %s: %w", c.Bucket, err)
		}
	}
	return &S3{client: client, bucket: c.Bucket, where: c.Endpoint + "/" + c.Bucket}, nil
}

func (s *S3) Put(ctx context.Context, key string, data []byte) error {
	return putBytes(ctx, s, key, data)
}

// PutReader sends the object in one streamed PUT: no multipart upload, so
// the client never buffers parts in memory. kimmi's objects stay far below
// the 5 GiB single-PUT limit.
func (s *S3) PutReader(ctx context.Context, key string, r io.Reader, size int64) error {
	_, err := s.client.PutObject(ctx, s.bucket, key, r, size,
		minio.PutObjectOptions{ContentType: "application/octet-stream", DisableMultipart: true})
	if err != nil {
		return fmt.Errorf("put %s: %w", key, err)
	}
	return nil
}

func (s *S3) Get(ctx context.Context, key string, offset, length int64) ([]byte, error) {
	if length == 0 {
		return []byte{}, nil
	}
	opts := minio.GetObjectOptions{}
	var err error
	if length > 0 {
		err = opts.SetRange(offset, offset+length-1)
	} else if offset > 0 {
		err = opts.SetRange(offset, 0)
	}
	if err != nil {
		return nil, fmt.Errorf("get %s: %w", key, err)
	}
	obj, err := s.client.GetObject(ctx, s.bucket, key, opts)
	if err != nil {
		return nil, fmt.Errorf("get %s: %w", key, err)
	}
	defer obj.Close()
	var data []byte
	if length > 0 {
		// A range read of known size fills one exact buffer instead of
		// growing one.
		data = make([]byte, length)
		var n int
		n, err = io.ReadFull(obj, data)
		data = data[:n]
		if errors.Is(err, io.ErrUnexpectedEOF) {
			err = fmt.Errorf("short read: %d of %d bytes", n, length)
		}
	} else {
		data, err = io.ReadAll(obj)
	}
	if err != nil {
		if minio.ToErrorResponse(err).Code == minio.NoSuchKey {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("get %s [%d+%d]: %w", key, offset, length, err)
	}
	return data, nil
}

func (s *S3) Delete(ctx context.Context, key string) error {
	if err := s.client.RemoveObject(ctx, s.bucket, key, minio.RemoveObjectOptions{}); err != nil {
		return fmt.Errorf("delete %s: %w", key, err)
	}
	return nil
}

func (s *S3) List(ctx context.Context, prefix string) iter.Seq2[Object, error] {
	return func(yield func(Object, error) bool) {
		ctx, cancel := context.WithCancel(ctx)
		defer cancel()
		for o := range s.client.ListObjects(ctx, s.bucket, minio.ListObjectsOptions{Prefix: prefix, Recursive: true}) {
			if o.Err != nil {
				yield(Object{}, fmt.Errorf("list %s: %w", prefix, o.Err))
				return
			}
			if !yield(Object{Key: o.Key, Size: o.Size}, nil) {
				return
			}
		}
	}
}

func (s *S3) Driver() string   { return "s3" }
func (s *S3) Location() string { return s.where }
