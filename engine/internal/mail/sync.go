// SPDX-License-Identifier: AGPL-3.0-only

package mail

import (
	"context"
	"crypto/rand"
	"errors"
	"slices"

	"github.com/emersion/go-imap/v2"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/db"
	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/secret"
)

// Put stores an object, e.g. in S3.
type Put func(ctx context.Context, key string, data []byte, contentType string) error

// Sync fetches new messages in the account's INBOX and returns the account's version afterwards. Each message is
// stored whole as raw/<id>.eml and the part to show as body/<id>.html.
// ponytail: INBOX only, new messages only. Flag changes and deletions need CONDSTORE/QRESYNC, other folders LIST.
func Sync(ctx context.Context, pool *pgxpool.Pool, put Put, master []byte, accountID string) (int64, error) {
	acc, err := db.New(pool).GetAccount(ctx, accountID)
	if err != nil {
		return 0, err
	}
	pass, err := secret.Open(master, acc.Secret)
	if err != nil {
		return 0, err
	}
	c, err := DialIMAP(acc.ImapHost, int(acc.ImapPort), acc.Username, pass, nil)
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
		// The server renumbered the folder, so every UID we stored is meaningless now. Clients drop the old rows
		// and get everything again with new ids.
		var gone []string
		if gone, err = q.ClearMailbox(ctx, box.ID); err == nil {
			err = q.SetUIDValidity(ctx, db.SetUIDValidityParams{ID: box.ID, UidValidity: int64(sel.UIDValidity)})
		}
		for _, id := range gone {
			if err == nil {
				acc.Version, err = q.LogChange(ctx, db.LogChangeParams{AccountID: acc.ID, Entity: "message", EntityID: id, Op: "delete"})
			}
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
		whole := &imap.FetchItemBodySection{Peek: true}
		msgs, err := c.Fetch(uids, &imap.FetchOptions{
			UID: true, Envelope: true, Flags: true, RFC822Size: true, InternalDate: true,
			BodySection: []*imap.FetchItemBodySection{whole},
		}).Collect()
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
				Flags:     flagStrings(m.Flags),
				Size:      int32(m.RFC822Size),
			}
			if len(m.Envelope.From) > 0 {
				row.FromName, row.FromAddr = m.Envelope.From[0].Name, m.Envelope.From[0].Addr()
			}
			raw := m.FindBodySection(whole)
			// An unparsable message still shows up, just without a body to read.
			body, snippet, _ := Body(raw)
			row.Snippet = snippet
			if err := put(ctx, "raw/"+row.ID+".eml", raw, "message/rfc822"); err != nil {
				return 0, err
			}
			if err := put(ctx, "body/"+row.ID+".html", []byte(body), "text/html; charset=utf-8"); err != nil {
				return 0, err
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

	// Flags and deletions of messages we already have: compare every UID's flags with what we stored.
	// ponytail: fetches the flags of the whole folder each time; CONDSTORE/QRESYNC once folders get big.
	server := map[int64][]string{}
	if sel.NumMessages > 0 {
		var all imap.UIDSet
		all.AddRange(1, 0)
		msgs, err := c.Fetch(all, &imap.FetchOptions{UID: true, Flags: true}).Collect()
		if err != nil {
			return 0, err
		}
		for _, m := range msgs {
			server[int64(m.UID)] = flagStrings(m.Flags)
		}
	}
	stored, err := q.ListFlags(ctx, box.ID)
	if err != nil {
		return 0, err
	}
	for _, r := range stored {
		flags, ok := server[r.Uid]
		op := "upsert"
		switch {
		case !ok:
			op = "delete"
			err = q.DeleteMessage(ctx, r.ID)
		case !slices.Equal(flags, r.Flags):
			err = q.SetFlags(ctx, db.SetFlagsParams{ID: r.ID, Flags: flags})
		default:
			continue
		}
		if err == nil {
			version, err = q.LogChange(ctx, db.LogChangeParams{AccountID: acc.ID, Entity: "message", EntityID: r.ID, Op: op})
		}
		if err != nil {
			return 0, err
		}
	}
	return version, tx.Commit(ctx)
}

// flagStrings returns the flags sorted, so stored and fetched lists compare equal.
func flagStrings(flags []imap.Flag) []string {
	s := make([]string, len(flags))
	for i, f := range flags {
		s[i] = string(f)
	}
	slices.Sort(s)
	return s
}
