// SPDX-License-Identifier: AGPL-3.0-only

package mail

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strings"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapclient"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/db"
	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/seal"
	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/secret"
)

// Put stores an object, e.g. in S3.
type Put func(ctx context.Context, key string, data []byte, contentType string) error

// Store keeps the parts of messages: Drop removes a message's body and attachments.
type Store struct {
	Put  Put
	Drop func(ctx context.Context, messageID string) error
}

// Meta is what only the user can read about a message, sealed into message.sealed. The clients read the same
// fields (packages/sdk, apps/apple).
type Meta struct {
	MessageID   string   `json:"messageId"`
	Subject     string   `json:"subject"`
	Snippet     string   `json:"snippet"`
	FromName    string   `json:"fromName"`
	FromAddr    string   `json:"fromAddr"`
	To          []string `json:"to"`
	Cc          []string `json:"cc"`
	Attachments []File   `json:"attachments"`
	Actions     []Action `json:"actions"`
}

// Hashed is how Message-IDs are stored: equal ones still match, for conversations, without keeping the header.
func Hashed(id string) string {
	if id == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(id))
	return hex.EncodeToString(sum[:])
}

// Sync brings every folder of the account up to date and returns the account's version afterwards. Each new
// message is sealed to the user's public key: its Meta in the row, the part to show as body/<id>.html, attachments
// as att/<id>/<index>. Work is saved folder by folder and in batches of new messages; progress is called with the
// version after each save. Without a key nothing is fetched: the user hasn't set a password yet.
func Sync(ctx context.Context, pool *pgxpool.Pool, store Store, master []byte, accountID string, progress func(version int64)) (int64, error) {
	acc, err := db.New(pool).GetAccount(ctx, accountID)
	if err != nil {
		return 0, err
	}
	pub, err := db.New(pool).GetUserKey(ctx, accountID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return 0, err
	}
	s := &syncer{ctx: ctx, pool: pool, store: store, progress: progress, acc: acc, pub: pub}
	if err := s.begin(); err != nil {
		return 0, err
	}
	defer func() { _ = s.tx.Rollback(ctx) }()
	// A new key (after a reset) can't open what was sealed to the old one: start over.
	if !bytes.Equal(acc.SealedTo, pub) {
		stored, err := s.q.ListMailboxes(ctx, acc.ID)
		if err != nil {
			return 0, err
		}
		for _, b := range stored {
			if err := s.drop(b.ID); err != nil {
				return 0, err
			}
		}
		if err := s.q.SetSealedTo(ctx, db.SetSealedToParams{ID: acc.ID, SealedTo: pub}); err != nil {
			return 0, err
		}
	}
	if pub == nil {
		return s.acc.Version, s.tx.Commit(ctx)
	}

	pass, err := secret.Open(master, acc.Secret)
	if err != nil {
		return 0, err
	}
	if s.c, err = DialIMAP(acc.ImapHost, int(acc.ImapPort), acc.Username, pass, nil); err != nil {
		return 0, err
	}
	defer func() { _ = s.c.Logout().Wait() }()
	boxes, err := s.c.List("", "*", &imap.ListOptions{ReturnSpecialUse: s.c.Caps().Has(imap.CapSpecialUse)}).Collect()
	if err != nil {
		return 0, err
	}

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
		if err := s.drop(b.ID); err != nil {
			return 0, err
		}
	}
	return s.acc.Version, s.tx.Commit(ctx)
}

// drop removes a folder with its messages.
func (s *syncer) drop(boxID string) error {
	if err := s.clear(boxID); err != nil {
		return err
	}
	if err := s.q.DeleteMailbox(s.ctx, boxID); err != nil {
		return err
	}
	return s.log("mailbox", boxID, "delete")
}

type syncer struct {
	ctx      context.Context
	pool     *pgxpool.Pool
	tx       pgx.Tx
	q        *db.Queries
	c        *imapclient.Client
	store    Store
	progress func(version int64)
	acc      db.MailAccount
	pub      []byte
}

func (s *syncer) begin() (err error) {
	s.tx, err = s.pool.Begin(s.ctx)
	s.q = db.New(s.tx)
	return err
}

// commit saves what is done so far, so a dropped connection later doesn't lose it, and reports the new version.
func (s *syncer) commit() error {
	if err := s.tx.Commit(s.ctx); err != nil {
		return err
	}
	s.progress(s.acc.Version)
	return s.begin()
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
			err = s.gone(id)
		}
	}
	return err
}

// gone logs a deleted message and removes its parts.
func (s *syncer) gone(id string) error {
	if err := s.log("message", id, "delete"); err != nil {
		return err
	}
	return s.store.Drop(s.ctx, id)
}

// ponytail: new messages by UID and a full flag scan per folder; CONDSTORE/QRESYNC once folders get big.
func (s *syncer) folder(name, role string) error {
	ctx := s.ctx
	sel, err := s.c.Select(name, &imap.SelectOptions{ReadOnly: true}).Wait()
	if err != nil {
		return err
	}

	box, err := s.q.GetMailbox(ctx, db.GetMailboxParams{AccountID: s.acc.ID, Name: name})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		box = db.Mailbox{ID: rand.Text(), AccountID: s.acc.ID, Name: name, Role: role, UidValidity: int64(sel.UIDValidity)}
		err = s.q.CreateMailbox(ctx, db.CreateMailboxParams{ID: box.ID, AccountID: box.AccountID, Name: name, Role: role, UidValidity: box.UidValidity})
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
			err = s.q.UpdateMailbox(ctx, db.UpdateMailboxParams{ID: box.ID, Role: role, UidValidity: int64(sel.UIDValidity)})
		}
		if err == nil {
			err = s.log("mailbox", box.ID, "upsert")
		}
	}
	if err != nil {
		return err
	}

	last, err := s.q.MaxUID(ctx, box.ID)
	if err != nil {
		return err
	}
	if sel.NumMessages > 0 {
		var uids imap.UIDSet
		uids.AddRange(imap.UID(last+1), 0)
		found, err := s.c.Fetch(uids, &imap.FetchOptions{UID: true}).Collect()
		if err != nil {
			return err
		}
		var fresh []imap.UID
		for _, m := range found {
			if int64(m.UID) > last {
				fresh = append(fresh, m.UID)
			}
		}
		// In small batches, each saved right away: a dropped connection costs one batch, not the whole first sync.
		whole := &imap.FetchItemBodySection{Peek: true}
		for batch := range slices.Chunk(fresh, 50) {
			msgs, err := s.c.Fetch(imap.UIDSetNum(batch...), &imap.FetchOptions{
				UID: true, Envelope: true, Flags: true, RFC822Size: true, InternalDate: true,
				BodySection: []*imap.FetchItemBodySection{whole},
			}).Collect()
			if err != nil {
				return err
			}
			for _, m := range msgs {
				if m.Envelope == nil {
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
					MessageID: Hashed(m.Envelope.MessageID),
					SentAt:    pgtype.Timestamptz{Time: sent, Valid: true},
					Flags:     flagStrings(m.Flags),
					Size:      int32(m.RFC822Size),
				}
				raw := m.FindBodySection(whole)
				// An unparsable message still shows up, just without a body to read.
				parsed, err := Content(raw)
				if err != nil {
					slog.Warn("can't read message", "id", row.ID, "err", err)
				}
				meta := Meta{
					MessageID: m.Envelope.MessageID, Subject: m.Envelope.Subject, Snippet: parsed.Snippet,
					To: addrs(m.Envelope.To), Cc: addrs(m.Envelope.Cc),
					// Empty lists rather than null.
					Attachments: append([]File{}, parsed.Files...), Actions: append([]Action{}, parsed.Actions...),
				}
				if len(m.Envelope.From) > 0 {
					meta.FromName, meta.FromAddr = m.Envelope.From[0].Name, m.Envelope.From[0].Addr()
				}
				row.Category = parsed.Category
				key := seal.NewKey()
				if row.Key, err = seal.Wrap(s.pub, key); err != nil {
					return err
				}
				plain, _ := json.Marshal(meta)
				row.Sealed = seal.Encrypt(key, "meta", plain)
				for i, f := range parsed.Files {
					label := fmt.Sprintf("att/%d", i)
					if err := s.store.Put(ctx, fmt.Sprintf("att/%s/%d", row.ID, i), seal.Encrypt(key, label, f.Data), "application/octet-stream"); err != nil {
						return err
					}
				}
				refs := References(raw)
				for i, r := range refs {
					refs[i] = Hashed(r)
				}
				row.Refs = refs
				if row.ThreadID, err = thread(ctx, s.q, s.acc.ID, row.MessageID, row.Refs, func(id string) error {
					return s.log("message", id, "upsert")
				}); err != nil {
					return err
				}
				if err := s.store.Put(ctx, "body/"+row.ID+".html", seal.Encrypt(key, "body", []byte(parsed.Body)), "application/octet-stream"); err != nil {
					return err
				}
				if n, err := s.q.InsertMessage(ctx, row); err != nil {
					return err
				} else if n == 0 {
					continue
				}
				if err := s.log("message", row.ID, "upsert"); err != nil {
					return err
				}
			}
			if err := s.commit(); err != nil {
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
	stored, err := s.q.ListFlags(ctx, box.ID)
	if err != nil {
		return err
	}
	for _, r := range stored {
		flags, ok := server[r.Uid]
		switch {
		case !ok:
			if err = s.q.DeleteMessage(ctx, r.ID); err == nil {
				err = s.gone(r.ID)
			}
		case !slices.Equal(flags, r.Flags):
			if err = s.q.SetFlags(ctx, db.SetFlagsParams{ID: r.ID, Flags: flags}); err == nil {
				err = s.log("message", r.ID, "upsert")
			}
		default:
			continue
		}
		if err != nil {
			return err
		}
	}
	return s.commit()
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
	"snoozed": "snoozed",
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

func addrs(list []imap.Address) []string {
	s := make([]string, len(list))
	for i, a := range list {
		s[i] = a.Addr()
	}
	return s
}

// flagStrings returns the flags sorted, so stored and fetched lists compare equal. \Recent is left out: it only
// holds for the session that first sees a message, so the next sync would count every message as changed.
func flagStrings(flags []imap.Flag) []string {
	s := []string{}
	for _, f := range flags {
		if f != `\Recent` {
			s = append(s, string(f))
		}
	}
	slices.Sort(s)
	return s
}
