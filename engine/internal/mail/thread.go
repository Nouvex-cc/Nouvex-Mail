// SPDX-License-Identifier: AGPL-3.0-only

package mail

import (
	"bytes"
	"context"
	"crypto/rand"
	"slices"

	"github.com/emersion/go-message/mail"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/db"
)

// References returns the Message-IDs a raw message answers, from In-Reply-To and References.
func References(raw []byte) []string {
	mr, err := mail.CreateReader(bytes.NewReader(raw))
	if err != nil {
		return []string{}
	}
	defer func() { _ = mr.Close() }()
	refs, _ := mr.Header.MsgIDList("References")
	parent, _ := mr.Header.MsgIDList("In-Reply-To")
	slices.Sort(refs)
	for _, id := range parent {
		if _, found := slices.BinarySearch(refs, id); !found {
			refs = append(refs, id)
		}
	}
	if refs == nil {
		return []string{}
	}
	return refs
}

// thread finds the conversation of a message from the messages it answers, the ones that answer it and other copies
// of it. When it joins several conversations, they become one, and moved messages are reported through changed.
// ponytail: headers only; mail without In-Reply-To/References (some forwards, old clients) starts its own thread.
func thread(ctx context.Context, q *db.Queries, accountID, messageID string, refs []string, changed func(id string) error) (string, error) {
	found, err := q.ThreadsFor(ctx, db.ThreadsForParams{AccountID: accountID, Refs: refs, MessageID: messageID})
	if err != nil {
		return "", err
	}
	if len(found) == 0 {
		if messageID != "" {
			return messageID, nil
		}
		return rand.Text(), nil
	}
	keep := found[0]
	for _, other := range found[1:] {
		moved, err := q.MergeThread(ctx, db.MergeThreadParams{Keep: keep, AccountID: accountID, ThreadID: other})
		if err != nil {
			return "", err
		}
		for _, id := range moved {
			if err := changed(id); err != nil {
				return "", err
			}
		}
	}
	return keep, nil
}

// BackfillThreads gives messages synced before conversations existed their references and conversation, oldest
// first so answers find what they answer.
func BackfillThreads(ctx context.Context, pool *pgxpool.Pool, get Get) (int, error) {
	rows, err := db.New(pool).ListThreadless(ctx)
	if err != nil {
		return 0, err
	}
	for i, r := range rows {
		raw, err := get(ctx, "raw/"+r.ID+".eml")
		if err != nil {
			return i, err
		}
		refs := References(raw)
		tx, err := pool.Begin(ctx)
		if err != nil {
			return i, err
		}
		q := db.New(tx)
		logChange := func(id string) error {
			_, err := q.LogChange(ctx, db.LogChangeParams{AccountID: r.AccountID, Entity: "message", EntityID: id, Op: "upsert"})
			return err
		}
		id, err := thread(ctx, q, r.AccountID, r.MessageID, refs, logChange)
		if err == nil {
			err = q.SetThread(ctx, db.SetThreadParams{ID: r.ID, Refs: refs, ThreadID: id})
		}
		if err == nil {
			err = logChange(r.ID)
		}
		if err != nil {
			_ = tx.Rollback(ctx)
			return i, err
		}
		if err := tx.Commit(ctx); err != nil {
			return i, err
		}
	}
	return len(rows), nil
}
