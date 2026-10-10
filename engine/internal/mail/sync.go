// SPDX-License-Identifier: AGPL-3.0-only

package mail

import (
	"context"
	"crypto/rand"
	"errors"
	"slices"
	"strings"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapclient"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/db"
	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/secret"
)

// Put stores an object, e.g. in S3.
type Put func(ctx context.Context, key string, data []byte, contentType string) error

// Sync brings every folder of the account up to date and returns the account's version afterwards. Each new
// message is stored whole as raw/<id>.eml and the part to show as body/<id>.html.
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
	boxes, err := c.List("", "*", &imap.ListOptions{ReturnSpecialUse: c.Caps().Has(imap.CapSpecialUse)}).Collect()
	if err != nil {
		return 0, err
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	s := &syncer{ctx: ctx, c: c, q: db.New(tx), put: put, acc: acc}

	listed := map[string]bool{}
	for _, b := range boxes {
		// Virtual folders (\All, \Flagged) would show every message twice.
		if slices.ContainsFunc(b.Attrs, func(a imap.MailboxAttr) bool {
			return a == imap.MailboxAttrNoSelect || a == imap.MailboxAttrNonExistent || a == imap.MailboxAttrAll || a == imap.MailboxAttrFlagged
		}) {
			continue
		}
		listed[b.Mailbox] = true
		if err := s.folder(b.Mailbox, role(b)); err != nil {
			return 0, err
		}
	}

	stored, err := s.q.ListMailboxes(ctx, acc.ID)
	if err != nil {
		return 0, err
	}
	for _, b := range stored {
		if listed[b.Name] {
			continue
		}
		// Deleted or renamed on the server; a renamed one comes back as a new folder.
		if err := s.clear(b.ID); err != nil {
			return 0, err
		}
		if err := s.q.DeleteMailbox(ctx, b.ID); err != nil {
			return 0, err
		}
		if err := s.log("mailbox", b.ID, "delete"); err != nil {
			return 0, err
		}
	}
	return s.acc.Version, tx.Commit(ctx)
}

type syncer struct {
	ctx context.Context
	c   *imapclient.Client
	q   *db.Queries
	put Put
	acc db.MailAccount
}

func (s *syncer) log(entity, id, op string) (err error) {
	s.acc.Version, err = s.q.LogChange(s.ctx, db.LogChangeParams{AccountID: s.acc.ID, Entity: entity, EntityID: id, Op: op})
	return err
}

// clear drops every message of a folder.
func (s *syncer) clear(boxID string) error {
	gone, err := s.q.ClearMailbox(s.ctx, boxID)
	for _, id := range gone {
		if err == nil {
			err = s.log("message", id, "delete")
		}
	}
	return err
}

// ponytail: new messages by UID and a full flag scan per folder; CONDSTORE/QRESYNC once folders get big.
func (s *syncer) folder(name, role string) error {
	ctx, q := s.ctx, s.q
	sel, err := s.c.Select(name, &imap.SelectOptions{ReadOnly: true}).Wait()
	if err != nil {
		return err
	}

	box, err := q.GetMailbox(ctx, db.GetMailboxParams{AccountID: s.acc.ID, Name: name})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		box = db.Mailbox{ID: rand.Text(), AccountID: s.acc.ID, Name: name, Role: role, UidValidity: int64(sel.UIDValidity)}
		err = q.CreateMailbox(ctx, db.CreateMailboxParams{ID: box.ID, AccountID: box.AccountID, Name: name, Role: role, UidValidity: box.UidValidity})
		if err == nil {
			err = s.log("mailbox", box.ID, "upsert")
		}
	case err == nil && (box.UidValidity != int64(sel.UIDValidity) || box.Role != role):
		// A new UIDVALIDITY means the server renumbered the folder, so every UID we stored is meaningless now.
		// Clients drop the old rows and get everything again with new ids.
		if box.UidValidity != int64(sel.UIDValidity) {
			err = s.clear(box.ID)
		}
		if err == nil {
			err = q.UpdateMailbox(ctx, db.UpdateMailboxParams{ID: box.ID, Role: role, UidValidity: int64(sel.UIDValidity)})
		}
		if err == nil {
			err = s.log("mailbox", box.ID, "upsert")
		}
	}
	if err != nil {
		return err
	}

	last, err := q.MaxUID(ctx, box.ID)
	if err != nil {
		return err
	}
	if sel.NumMessages > 0 {
		var uids imap.UIDSet
		uids.AddRange(imap.UID(last+1), 0)
		// ponytail: collects the whole batch in memory, stream it once first syncs of big mailboxes matter.
		whole := &imap.FetchItemBodySection{Peek: true}
		msgs, err := s.c.Fetch(uids, &imap.FetchOptions{
			UID: true, Envelope: true, Flags: true, RFC822Size: true, InternalDate: true,
			BodySection: []*imap.FetchItemBodySection{whole},
		}).Collect()
		if err != nil {
			return err
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
				AccountID: s.acc.ID,
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
			if err := s.put(ctx, "raw/"+row.ID+".eml", raw, "message/rfc822"); err != nil {
				return err
			}
			if err := s.put(ctx, "body/"+row.ID+".html", []byte(body), "text/html; charset=utf-8"); err != nil {
				return err
			}
			if n, err := q.InsertMessage(ctx, row); err != nil {
				return err
			} else if n == 0 {
				continue
			}
			if err := s.log("message", row.ID, "upsert"); err != nil {
				return err
			}
		}
	}

	// Flags and deletions of messages we already have: compare every UID's flags with what we stored.
	server := map[int64][]string{}
	if sel.NumMessages > 0 {
		var all imap.UIDSet
		all.AddRange(1, 0)
		msgs, err := s.c.Fetch(all, &imap.FetchOptions{UID: true, Flags: true}).Collect()
		if err != nil {
			return err
		}
		for _, m := range msgs {
			server[int64(m.UID)] = flagStrings(m.Flags)
		}
	}
	stored, err := q.ListFlags(ctx, box.ID)
	if err != nil {
		return err
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
			err = s.log("message", r.ID, op)
		}
		if err != nil {
			return err
		}
	}
	return nil
}

var roles = map[imap.MailboxAttr]string{
	imap.MailboxAttrSent:    "sent",
	imap.MailboxAttrDrafts:  "drafts",
	imap.MailboxAttrTrash:   "trash",
	imap.MailboxAttrJunk:    "junk",
	imap.MailboxAttrArchive: "archive",
}

// Names servers without SPECIAL-USE commonly use.
var roleNames = map[string]string{
	"sent": "sent", "sent items": "sent", "sent messages": "sent",
	"drafts": "drafts",
	"trash":  "trash", "deleted items": "trash", "deleted messages": "trash",
	"junk": "junk", "spam": "junk",
	"archive": "archive",
}

func role(b *imap.ListData) string {
	if strings.EqualFold(b.Mailbox, "INBOX") {
		return "inbox"
	}
	for _, a := range b.Attrs {
		if r, ok := roles[a]; ok {
			return r
		}
	}
	return roleNames[strings.ToLower(b.Mailbox)]
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
