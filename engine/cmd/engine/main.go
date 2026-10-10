// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/url"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/getsentry/sentry-go"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"

	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/db"
	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/mail"
	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/msg"
	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/secret"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	if err := run(); err != nil {
		slog.Error("engine stopped", "err", err)
		os.Exit(1)
	}
}

func run() error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if dsn := os.Getenv("SENTRY_DSN"); dsn != "" {
		if err := sentry.Init(sentry.ClientOptions{Dsn: dsn}); err != nil {
			return err
		}
	}
	if os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT") != "" {
		exp, err := otlptracehttp.New(ctx)
		if err != nil {
			return err
		}
		tp := sdktrace.NewTracerProvider(sdktrace.WithBatcher(exp))
		defer func() { _ = tp.Shutdown(context.Background()) }()
		otel.SetTracerProvider(tp)
	}

	master, err := secret.Key()
	if err != nil {
		return err
	}
	put, err := bucket(ctx)
	if err != nil {
		return err
	}
	pool, err := pgxpool.New(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		return err
	}
	defer pool.Close()

	nc, err := nats.Connect(cmp.Or(os.Getenv("NATS_URL"), nats.DefaultURL))
	if err != nil {
		return err
	}
	defer func() { _ = nc.Drain() }()
	js, err := jetstream.New(nc)
	if err != nil {
		return err
	}
	stream, err := js.CreateOrUpdateStream(ctx, jetstream.StreamConfig{Name: "COMMANDS", Subjects: []string{"cmd.>"}})
	if err != nil {
		return err
	}
	cons, err := stream.CreateOrUpdateConsumer(ctx, jetstream.ConsumerConfig{
		Durable:        "engine",
		FilterSubjects: []string{"cmd.mailbox.sync", "cmd.message.update"},
		AckPolicy:      jetstream.AckExplicitPolicy,
		// A server that is down or a wrong password shouldn't be retried forever.
		MaxDeliver: 5,
	})
	if err != nil {
		return err
	}

	// Every account gets an IDLE watcher that queues a sync when new mail arrives.
	var mu sync.Mutex
	watched := map[string]bool{}
	watch := func(id string) {
		mu.Lock()
		defer mu.Unlock()
		if watched[id] {
			return
		}
		watched[id] = true
		cmd, _ := json.Marshal(msg.MailboxSync{AccountId: id})
		go func() {
			mail.Watch(ctx, db.New(pool), master, id, func() {
				if _, err := js.Publish(ctx, "cmd.mailbox.sync", cmd); err != nil {
					slog.Error("queue sync", "account", id, "err", err)
				}
			})
			mu.Lock()
			delete(watched, id)
			mu.Unlock()
		}()
	}
	ids, err := db.New(pool).ListAccountIDs(ctx)
	if err != nil {
		return err
	}
	for _, id := range ids {
		watch(id)
	}

	cc, err := cons.Consume(func(m jetstream.Msg) {
		var cmd msg.MailboxSync
		var update msg.MessageUpdate
		var err error
		if m.Subject() == "cmd.message.update" {
			err = json.Unmarshal(m.Data(), &update)
			cmd.AccountId = update.AccountId
		} else {
			err = json.Unmarshal(m.Data(), &cmd)
		}
		if err != nil {
			slog.Warn("bad command", "subject", m.Subject(), "err", err)
			_ = m.Term()
			return
		}
		if update.MessageId != "" {
			// A message that is gone already can't be changed anymore.
			if err := mail.Update(ctx, db.New(pool), master, update); errors.Is(err, pgx.ErrNoRows) {
				_ = m.Term()
				return
			} else if err != nil {
				slog.Error("update failed", "account", update.AccountId, "err", err)
				_ = m.NakWithDelay(time.Minute)
				return
			}
		}
		v, err := mail.Sync(ctx, pool, put, master, cmd.AccountId)
		if err != nil {
			slog.Error("sync failed", "account", cmd.AccountId, "err", err)
			_ = m.NakWithDelay(time.Minute)
			return
		}
		ev, _ := json.Marshal(msg.MailboxSynced{AccountId: cmd.AccountId, Version: int(v)})
		if err := nc.Publish("evt.mailbox.synced", ev); err != nil {
			_ = m.Nak()
			return
		}
		slog.Info("synced", "account", cmd.AccountId, "version", v)
		_ = m.Ack()
		watch(cmd.AccountId)
	})
	if err != nil {
		return err
	}
	defer cc.Stop()

	slog.Info("engine running")
	<-ctx.Done()
	return nil
}

// bucket connects to S3 with the same variables Bun's S3 client reads, and creates the bucket if needed.
func bucket(ctx context.Context) (mail.Put, error) {
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
	name := os.Getenv("S3_BUCKET")
	if ok, err := c.BucketExists(ctx, name); err != nil {
		return nil, err
	} else if !ok {
		if err := c.MakeBucket(ctx, name, minio.MakeBucketOptions{}); err != nil {
			return nil, err
		}
	}
	return func(ctx context.Context, key string, data []byte, contentType string) error {
		_, err := c.PutObject(ctx, name, key, bytes.NewReader(data), int64(len(data)), minio.PutObjectOptions{ContentType: contentType})
		return err
	}, nil
}
