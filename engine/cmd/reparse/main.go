// SPDX-License-Identifier: AGPL-3.0-only

// Command reparse reads stored messages again, after reading mail got better: go run ./cmd/reparse [account id]
package main

import (
	"context"
	"log/slog"
	"os"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/mail"
)

func main() {
	ctx := context.Background()
	put, get, err := mail.Bucket(ctx)
	if err != nil {
		slog.Error("s3", "err", err)
		os.Exit(1)
	}
	pool, err := pgxpool.New(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		slog.Error("db", "err", err)
		os.Exit(1)
	}
	defer pool.Close()
	n, err := mail.Reparse(ctx, pool, put, get, strings.Join(os.Args[1:], ""))
	if err != nil {
		slog.Error("reparse stopped", "changed", n, "err", err)
		os.Exit(1)
	}
	slog.Info("reparsed", "changed", n)
	t, err := mail.BackfillThreads(ctx, pool, get)
	if err != nil {
		slog.Error("threads stopped", "done", t, "err", err)
		os.Exit(1)
	}
	slog.Info("threads", "assigned", t)
}
