// SPDX-License-Identifier: AGPL-3.0-only

package mail

import (
	"context"
	"crypto/rand"
	"errors"

	"github.com/emersion/go-imap/v2"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/db"
	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/secret"
)

// Sync fetches new messages in the account's INBOX and returns the account's version afterwards.
// ponytail: INBOX only, new messages only. Flag changes and deletions need CONDSTORE/QRESYNC, other folders LIST.
func Sync(ctx context.Context, pool *pgxpool.Pool, master []byte, accountID string) (int64, error) {
	acc, err := db.New(pool).GetAccount(ctx, accountID)
	if err != nil {
		return 0, err
	}
	pass, err := secret.Open(master, acc.Secret)
	if err != nil {
		return 0, err
	}
	c, err := DialIMAP(acc.ImapHost, int(acc.ImapPort), acc.Username, pass)
	if err != nil {
		return 0, err
	}
	defer func() { _ = c.Logout().Wait() }()

	sel, err := c.Select("INBOX", nil).Wait()
	if err != nil {
		return 0, err
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)

	box, err := q.GetMailbox(ctx, db.GetMailboxParams{AccountID: acc.ID, Name: "INBOX"})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		box = db.Mailbox{ID: rand.Text(), AccountID: acc.ID, Name: "INBOX", UidValidity: int64(sel.UIDValidity)}
		err = q.CreateMailbox(ctx, db.CreateMailboxParams(box))
	case err == nil && box.UidValidity != int64(sel.UIDValidity):
		// The server renumbered the folder, so every UID we stored is meaningless now.
		if err = q.ClearMailbox(ctx, box.ID); err == nil {
			err = q.SetUIDValidity(ctx, db.SetUIDValidityParams{ID: box.ID, UidValidity: int64(sel.UIDValidity)})
		}
	}
	if err != nil {
		return 0, err
	}

	last, err := q.MaxUID(ctx, box.ID)
	if err != nil {
		return 0, err
	}
	version := acc.Version
	if sel.NumMessages > 0 {
		var uids imap.UIDSet
		uids.AddRange(imap.UID(last+1), 0)
		// ponytail: collects the whole batch in memory, stream it once first syncs of big mailboxes matter.
		msgs, err := c.Fetch(uids, &imap.FetchOptions{UID: true, Envelope: true, Flags: true, RFC822Size: true, InternalDate: true}).Collect()
		if err != nil {
			return 0, err
		}
		for _, m := range msgs {
			if int64(m.UID) <= last || m.Envelope == nil {
				continue
			}
			sent := m.Envelope.Date
			if sent.IsZero() {
				sent = m.InternalDate
			}
			row := db.InsertMessageParams{
				ID:        rand.Text(),
				AccountID: acc.ID,
				MailboxID: box.ID,
				Uid:       int64(m.UID),
				MessageID: m.Envelope.MessageID,
				Subject:   m.Envelope.Subject,
				SentAt:    pgtype.Timestamptz{Time: sent, Valid: true},
				Flags:     make([]string, len(m.Flags)),
				Size:      int32(m.RFC822Size),
			}
			if len(m.Envelope.From) > 0 {
				row.FromName, row.FromAddr = m.Envelope.From[0].Name, m.Envelope.From[0].Addr()
			}
			for i, f := range m.Flags {
				row.Flags[i] = string(f)
			}
			if n, err := q.InsertMessage(ctx, row); err != nil {
				return 0, err
			} else if n == 0 {
				continue
			}
			if version, err = q.LogChange(ctx, db.LogChangeParams{AccountID: acc.ID, Entity: "message", EntityID: row.ID, Op: "upsert"}); err != nil {
				return 0, err
			}
		}
	}
	return version, tx.Commit(ctx)
}
