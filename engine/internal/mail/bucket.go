// SPDX-License-Identifier: AGPL-3.0-only

package mail

import (
	"bytes"
	"context"
	"io"
	"net/url"
	"os"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// Bucket connects to S3 with the same variables Bun's S3 client reads, and creates the bucket if needed.
func Bucket(ctx context.Context) (Put, Get, error) {
	u, err := url.Parse(os.Getenv("S3_ENDPOINT"))
	if err != nil {
		return nil, nil, err
	}
	tr, err := minio.DefaultTransport(u.Scheme == "https")
	if err != nil {
		return nil, nil, err
	}
	// Fewer idle connections than parallel uploads, and every upload beyond them opens and drops a connection.
	tr.MaxIdleConnsPerHost = uploads
	c, err := minio.New(u.Host, &minio.Options{
		Creds:     credentials.NewStaticV4(os.Getenv("S3_ACCESS_KEY_ID"), os.Getenv("S3_SECRET_ACCESS_KEY"), ""),
		Secure:    u.Scheme == "https",
		Transport: tr,
	})
	if err != nil {
		return nil, nil, err
	}
	name := os.Getenv("S3_BUCKET")
	if ok, err := c.BucketExists(ctx, name); err != nil {
		return nil, nil, err
	} else if !ok {
		if err := c.MakeBucket(ctx, name, minio.MakeBucketOptions{}); err != nil {
			return nil, nil, err
		}
	}
	put := func(ctx context.Context, key string, data []byte, contentType string) error {
		_, err := c.PutObject(ctx, name, key, bytes.NewReader(data), int64(len(data)), minio.PutObjectOptions{ContentType: contentType})
		return err
	}
	get := func(ctx context.Context, key string) ([]byte, error) {
		o, err := c.GetObject(ctx, name, key, minio.GetObjectOptions{})
		if err != nil {
			return nil, err
		}
		defer func() { _ = o.Close() }()
		return io.ReadAll(o)
	}
	return put, get, nil
}
