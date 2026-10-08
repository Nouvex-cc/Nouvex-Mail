// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"cmp"
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/getsentry/sentry-go"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"

	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/db"
	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/msg"
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

	pool, err := pgxpool.New(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		return err
	}
	defer pool.Close()
	q := db.New(pool)

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
		Durable:       "engine",
		FilterSubject: "cmd.mailbox.sync",
		AckPolicy:     jetstream.AckExplicitPolicy,
	})
	if err != nil {
		return err
	}

	cc, err := cons.Consume(func(m jetstream.Msg) {
		var cmd msg.MailboxSync
		if err := json.Unmarshal(m.Data(), &cmd); err != nil {
			slog.Warn("bad command", "subject", m.Subject(), "err", err)
			_ = m.Term()
			return
		}
		v, err := q.LatestVersion(ctx, cmd.AccountId)
		if err != nil {
			slog.Error("sync failed", "account", cmd.AccountId, "err", err)
			_ = m.Nak()
			return
		}
		ev, _ := json.Marshal(msg.MailboxSynced{AccountId: cmd.AccountId, Version: int(v)})
		if err := nc.Publish("evt.mailbox.synced", ev); err != nil {
			_ = m.Nak()
			return
		}
		slog.Info("synced", "account", cmd.AccountId, "version", v)
		_ = m.Ack()
	})
	if err != nil {
		return err
	}
	defer cc.Stop()

	slog.Info("engine running")
	<-ctx.Done()
	return nil
}
