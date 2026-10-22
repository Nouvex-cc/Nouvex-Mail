// SPDX-License-Identifier: AGPL-3.0-only

package mail

import (
	"bytes"
	"context"
	"io"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"

	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/db"
)

// Bucket is where message bodies, attachments and uploads live, e.g. S3.
type Bucket struct {
	c    *minio.Client
	name string
}

// OpenBucket connects to S3 with the same variables Bun's S3 client reads, and creates the bucket if needed.
func OpenBucket(ctx context.Context) (*Bucket, error) {
	u, err := url.Parse(os.Getenv("S3_ENDPOINT"))
	if err != nil {
		return nil, err
	}
	c, err := minio.New(u.Host, &minio.Options{
		Creds:  credentials.NewStaticV4(os.Getenv("S3_ACCESS_KEY_ID"), os.Getenv("S3_SECRET_ACCESS_KEY"), ""),
		Secure: u.Scheme == "https",
	})
	if err != nil {
		return nil, err
	}
	b := &Bucket{c, os.Getenv("S3_BUCKET")}
	if ok, err := c.BucketExists(ctx, b.name); err != nil {
		return nil, err
	} else if !ok {
		if err := c.MakeBucket(ctx, b.name, minio.MakeBucketOptions{}); err != nil {
			return nil, err
		}
	}
	return b, nil
}

func (b *Bucket) Put(ctx context.Context, key string, data []byte, contentType string) error {
	_, err := b.c.PutObject(ctx, b.name, key, bytes.NewReader(data), int64(len(data)), minio.PutObjectOptions{ContentType: contentType})
	return err
}

func (b *Bucket) Get(ctx context.Context, key string) ([]byte, error) {
	o, err := b.c.GetObject(ctx, b.name, key, minio.GetObjectOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = o.Close() }()
	return io.ReadAll(o)
}

func (b *Bucket) Remove(ctx context.Context, key string) error {
	return b.c.RemoveObject(ctx, b.name, key, minio.RemoveObjectOptions{})
}

// Drop removes a message's body and attachments.
func (b *Bucket) Drop(ctx context.Context, id string) error {
	keys := []string{"body/" + id + ".html"}
	for o := range b.c.ListObjects(ctx, b.name, minio.ListObjectsOptions{Prefix: "att/" + id + "/", Recursive: true}) {
		if o.Err != nil {
			return o.Err
		}
		keys = append(keys, o.Key)
	}
	return b.remove(ctx, keys)
}

// Sweep removes the parts of messages that aren't stored anymore: everything from before mail was sealed (raw/ too),
// and what a crash between storing parts and the row left behind. Only safe while nothing syncs, so the engine runs
// it before taking commands.
func (b *Bucket) Sweep(ctx context.Context, q *db.Queries) error {
	byID := map[string][]string{}
	for _, prefix := range []string{"raw/", "body/", "att/"} {
		for o := range b.c.ListObjects(ctx, b.name, minio.ListObjectsOptions{Prefix: prefix, Recursive: true}) {
			if o.Err != nil {
				return o.Err
			}
			id := strings.TrimPrefix(o.Key, prefix)
			id, _, _ = strings.Cut(id, "/")
			id, _, _ = strings.Cut(id, ".")
			byID[id] = append(byID[id], o.Key)
		}
	}
	ids := make([]string, 0, len(byID))
	for id := range byID {
		ids = append(ids, id)
	}
	kept, err := q.KnownMessages(ctx, ids)
	if err != nil {
		return err
	}
	for _, id := range kept {
		delete(byID, id)
	}
	var keys []string
	for _, k := range byID {
		keys = append(keys, k...)
	}
	return b.remove(ctx, keys)
}

// SweepUploads removes attachments uploaded a day ago or earlier for messages that were never sent.
func (b *Bucket) SweepUploads(ctx context.Context) error {
	var keys []string
	for o := range b.c.ListObjects(ctx, b.name, minio.ListObjectsOptions{Prefix: "upload/", Recursive: true}) {
		if o.Err != nil {
			return o.Err
		}
		if time.Since(o.LastModified) > 24*time.Hour {
			keys = append(keys, o.Key)
		}
	}
	return b.remove(ctx, keys)
}

func (b *Bucket) remove(ctx context.Context, keys []string) error {
	objects := make(chan minio.ObjectInfo, len(keys))
	for _, k := range keys {
		objects <- minio.ObjectInfo{Key: k}
	}
	close(objects)
	for e := range b.c.RemoveObjects(ctx, b.name, objects, minio.RemoveObjectsOptions{}) {
		return e.Err
	}
	return nil
}
