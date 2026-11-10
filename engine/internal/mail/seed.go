// SPDX-License-Identifier: AGPL-3.0-only

package mail

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"log/slog"
	"strings"
	"time"

	"github.com/emersion/go-message/mail"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/db"
)

// localName is the local mailbox's name, one no mail server is likely to have, as names are unique per account.
const localName = "Nouvex announcements"

// Seed puts a message into a user's inbox in Nouvex only: sealed for them in a local mailbox of their first account,
// which syncing leaves alone, so their mail servers never see it. A message seeded before (same Message-ID) isn't
// added again, nor is anything for a user without an account or a key yet. It returns the account it changed.
func Seed(ctx context.Context, pool *pgxpool.Pool, store Store, userID string, raw []byte) (account string, version int64, err error) {
	q := db.New(pool)
	acc, err := q.FirstAccount(ctx, userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", 0, nil
	}
	if err != nil {
		return "", 0, err
	}
	pub, err := q.GetUserKey(ctx, acc.ID)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && pub == nil) {
		return "", 0, nil
	}
	if err != nil {
		return "", 0, err
	}
	s := &syncer{ctx: ctx, pool: pool, store: store, progress: func(int64, []string) {}, acc: acc, pub: pub}
	if err := s.begin(); err != nil {
		return "", 0, err
	}
	defer func() { _ = s.tx.Rollback(ctx) }()
	// Sealed to this key now; a first sync would otherwise take the account for one from before a reset and start over.
	if acc.SealedTo == nil {
		if err := s.q.SetSealedTo(ctx, db.SetSealedToParams{ID: acc.ID, SealedTo: pub}); err != nil {
			return "", 0, err
		}
	}
	name := localName
	if acc.Kind == "hosted" {
		name = "Inbox"
	}
	box, err := s.localBox("inbox", name)
	if err != nil {
		return "", 0, err
	}
	// Meant to be seen, whatever its headers look like.
	if _, added, err := s.ingest(box, raw, arrival{seeded: true}); err != nil || !added {
		return "", 0, err
	}
	if err := s.flush(); err != nil {
		return "", 0, err
	}
	return acc.ID, s.acc.Version, s.tx.Commit(ctx)
}

// arrival says how a message coming in is stored.
type arrival struct {
	flags []string
	// Put in a tab and checked for spam like synced mail; otherwise it's primary.
	sorted bool
	// Nouvex put it there itself (Meta.Seeded).
	seeded bool
}

// ingest stores a whole message in a local folder, sealed to the account's key like synced mail. One already in the
// folder (same Message-ID) isn't stored again. A hosted account keeps the message itself too, as eml/<id>: there's no
// server to fetch it from again for an export, a forward or "show original". It returns the row and whether it's new.
func (s *syncer) ingest(box db.Mailbox, raw []byte, a arrival) (*db.InsertMessageParams, bool, error) {
	if err := s.q.LockAccount(s.ctx, s.acc.ID); err != nil {
		return nil, false, err
	}
	r, err := mail.CreateReader(bytes.NewReader(raw))
	if err != nil {
		return nil, false, err
	}
	h := r.Header
	messageID, _ := h.MessageID()
	if there, err := s.q.HasMessageIn(s.ctx, db.HasMessageInParams{MailboxID: box.ID, MessageID: Hashed(messageID)}); err != nil || there {
		return nil, false, err
	}
	// An unparsable message still shows up, just without a body to read.
	parsed, err := Content(raw)
	if err != nil {
		slog.Warn("can't read message", "mailbox", box.ID, "err", err)
	}
	uid, err := s.q.MaxUID(s.ctx, box.ID)
	if err != nil {
		return nil, false, err
	}
	sent, err := h.Date()
	if err != nil || sent.IsZero() {
		sent = time.Now()
	}
	subject, _ := h.Subject()
	from, _ := h.AddressList("From")
	to, _ := h.AddressList("To")
	cc, _ := h.AddressList("Cc")
	replyTo, _ := h.AddressList("Reply-To")
	refs := References(raw)
	for i, r := range refs {
		refs[i] = Hashed(r)
	}
	row := db.InsertMessageParams{
		ID: rand.Text(), AccountID: s.acc.ID, MailboxID: box.ID, Uid: uid + 1, MessageID: Hashed(messageID),
		SentAt: pgtype.Timestamptz{Time: sent, Valid: true}, Flags: append([]string{}, a.flags...), Size: int32(len(raw)),
		Category: "primary", Refs: refs,
	}
	meta := Meta{
		MessageID: messageID, Subject: subject, Snippet: parsed.Snippet, To: names(to), Cc: names(cc),
		Attachments: append([]File{}, parsed.Files...), Actions: append([]Action{}, parsed.Actions...),
		Rich: parsed.Rich != "", Seeded: a.seeded, Unsubscribe: parsed.Unsubscribe,
	}
	if len(from) > 0 {
		meta.FromName, meta.FromAddr = from[0].Name, from[0].Address
	}
	if len(replyTo) > 0 && !strings.EqualFold(replyTo[0].Address, meta.FromAddr) {
		meta.ReplyTo = replyTo[0].Address
	}
	if a.sorted {
		if s.rules == nil {
			if err := s.loadSorting(); err != nil {
				return nil, false, err
			}
		}
		s.roles[box.ID] = box.Role
		row.Category, row.Spam, _ = s.sort(box.ID, meta.FromAddr, parsed)
	}
	var whole []byte
	if s.acc.Kind == "hosted" {
		whole = raw
	}
	if err := s.keep(&row, meta, parsed, whole); err != nil {
		return nil, false, err
	}
	added, err := s.insert(&row)
	return &row, added, err
}

func names(list []*mail.Address) []string {
	out := make([]string, len(list))
	for i, a := range list {
		out[i] = a.Address
	}
	return out
}
