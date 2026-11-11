// SPDX-License-Identifier: AGPL-3.0-only

// mx receives mail for the mailboxes Nouvex hosts, on port 25 (internal/mx). It keeps nothing itself: run as many as
// the MX records name.
package main

import (
	"cmp"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"

	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/db"
	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/mail"
	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/msg"
	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/mx"
	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/secret"
)

func main() {
	if err := run(); err != nil {
		slog.Error("mx stopped", "err", err)
		os.Exit(1)
	}
}

func run() error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	master, err := secret.Key()
	if err != nil {
		return err
	}
	bucket, err := mail.OpenBucket(ctx)
	if err != nil {
		return err
	}
	pool, err := pgxpool.New(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		return err
	}
	defer pool.Close()
	nc, err := nats.Connect(cmp.Or(os.Getenv("NATS_URL"), nats.DefaultURL), nats.MaxReconnects(-1))
	if err != nil {
		return err
	}
	defer nc.Close()
	js, err := jetstream.New(nc)
	if err != nil {
		return err
	}

	q := db.New(pool)
	deps := mx.Deps{
		Hostname: cmp.Or(os.Getenv("MX_HOSTNAME"), "localhost"),
		Master:   master,
		Lookup: func(ctx context.Context, address string) (string, error) {
			id, err := q.HostedAccount(ctx, address)
			if errors.Is(err, pgx.ErrNoRows) {
				return "", nil
			}
			return id, err
		},
		Spool: func(ctx context.Context, key string, sealed []byte) error {
			return bucket.Put(ctx, key, sealed, "application/octet-stream")
		},
		// The engine's stream takes cmd.>; Publish returns once it's stored.
		Deliver: func(ctx context.Context, d msg.MailDeliver, id string) error {
			data, _ := json.Marshal(d)
			_, err := js.Publish(ctx, "cmd.mail.deliver", data, jetstream.WithMsgID(id))
			return err
		},
	}
	if url := os.Getenv("RSPAMD_URL"); url != "" {
		deps.Check = mx.Rspamd(url, deps.Hostname)
	} else {
		slog.Warn("RSPAMD_URL not set: taking every message unchecked")
	}
	s := mx.Server(deps, cmp.Or(os.Getenv("MX_ADDR"), ":25"))
	if cert, key := os.Getenv("MX_TLS_CERT"), os.Getenv("MX_TLS_KEY"); cert != "" {
		// Read on every handshake: Caddy renews it in place, and may not have it yet on a new server.
		// ponytail: a file read per STARTTLS, cache by modification time if MX traffic ever makes that count.
		s.TLSConfig = &tls.Config{MinVersion: tls.VersionTLS12, GetCertificate: func(*tls.ClientHelloInfo) (*tls.Certificate, error) {
			pair, err := tls.LoadX509KeyPair(cert, key)
			return &pair, err
		}}
	}
	go func() {
		<-ctx.Done()
		_ = s.Close()
	}()
	slog.Info("mx listening", "addr", s.Addr, "tls", s.TLSConfig != nil)
	if err := s.ListenAndServe(); err != nil && ctx.Err() == nil {
		return err
	}
	return nil
}
