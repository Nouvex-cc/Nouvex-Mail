// SPDX-License-Identifier: AGPL-3.0-only

package mail

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/db"
	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/msg"
	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/secret"
)

// Receive stores a message our MX took for a hosted account: it waits in the bucket sealed with SECRETS_KEY, and is
// sealed here to the account's key like synced mail, sorted into a tab, and kept whole. A message delivered twice
// (same Message-ID) is stored once. It returns the account's version and the message if it is new, unread inbox mail.
func Receive(ctx context.Context, pool *pgxpool.Pool, store Store, get Get, master []byte, d msg.MailDeliver) (version int64, arrived []string, err error) {
	sealed, err := get(ctx, d.SpoolKey)
	if err != nil {
		return 0, nil, err
	}
	raw, err := secret.Open(master, sealed)
	if err != nil {
		return 0, nil, err
	}
	q := db.New(pool)
	acc, err := q.GetAccount(ctx, d.AccountId)
	if err != nil {
		return 0, nil, err
	}
	pub, err := q.GetUserKey(ctx, acc.ID)
	if err != nil {
		return 0, nil, err
	}
	s := &syncer{ctx: ctx, pool: pool, store: store, progress: func(int64, []string) {}, acc: acc, pub: pub}
	if err := s.begin(); err != nil {
		return 0, nil, err
	}
	defer func() { _ = s.tx.Rollback(ctx) }()
	box, err := s.localBox("inbox", "Inbox")
	if err != nil {
		return 0, nil, err
	}
	row, added, err := s.ingest(box, []byte(raw), arrival{flags: []string{}, sorted: true, spam: d.Spam})
	if err != nil {
		return 0, nil, err
	}
	if err := s.flush(); err != nil {
		return 0, nil, err
	}
	if err := s.tx.Commit(ctx); err != nil {
		return 0, nil, err
	}
	if added && !row.Spam {
		arrived = []string{row.ID}
	}
	return s.acc.Version, arrived, nil
}
