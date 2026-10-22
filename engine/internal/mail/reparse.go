// SPDX-License-Identifier: AGPL-3.0-only

package mail

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/db"
)

// Reparse reads stored messages again from their raw copy, for when reading mail got better: all of them, or one
// account's. Messages whose snippet, attachments, actions or tab come out different get a new body and a change_log entry, so
// clients fetch them again.
func Reparse(ctx context.Context, pool *pgxpool.Pool, put Put, get Get, accountID string) (changed int, err error) {
	rows, err := db.New(pool).ListContent(ctx, accountID)
	if err != nil {
		return 0, err
	}
	for _, r := range rows {
		raw, err := get(ctx, "raw/"+r.ID+".eml")
		if err != nil {
			return changed, err
		}
		// A missing copy is no reason to throw away what we have.
		if len(raw) == 0 {
			slog.Warn("no raw copy", "id", r.ID)
			continue
		}
		parsed, err := Content(raw)
		if err != nil {
			slog.Warn("can't read message", "id", r.ID, "err", err)
			continue
		}
		var stored []File
		_ = json.Unmarshal(r.Attachments, &stored)
		att, acts := parsed.columns()
		if parsed.Snippet == r.Snippet && len(parsed.Files) == len(stored) && bytes.Equal(acts, r.Actions) && parsed.Category == r.Category {
			continue
		}
		if err := put(ctx, "body/"+r.ID+".html", []byte(parsed.Body), "text/html; charset=utf-8"); err != nil {
			return changed, err
		}
		for i, f := range parsed.Files {
			if err := put(ctx, fmt.Sprintf("att/%s/%d", r.ID, i), f.Data, f.Type); err != nil {
				return changed, err
			}
		}
		tx, err := pool.Begin(ctx)
		if err != nil {
			return changed, err
		}
		q := db.New(tx)
		if err := q.SetContent(ctx, db.SetContentParams{ID: r.ID, Snippet: parsed.Snippet, Attachments: att, Actions: acts, Category: parsed.Category}); err != nil {
			_ = tx.Rollback(ctx)
			return changed, err
		}
		if _, err := q.LogChange(ctx, db.LogChangeParams{AccountID: r.AccountID, Entity: "message", EntityID: r.ID, Op: "upsert"}); err != nil {
			_ = tx.Rollback(ctx)
			return changed, err
		}
		if err := tx.Commit(ctx); err != nil {
			return changed, err
		}
		changed++
	}
	return changed, nil
}
