// SPDX-License-Identifier: AGPL-3.0-only

package mail

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
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
	if errors.Is(err, pgx.ErrNoRows) {
		return "", 0, nil
	}
	if err != nil {
		return "", 0, err
	}
	r, err := mail.CreateReader(bytes.NewReader(raw))
	if err != nil {
		return "", 0, err
	}
	h := r.Header
	messageID, _ := h.MessageID()
	if seeded, err := q.HasMessage(ctx, db.HasMessageParams{AccountID: acc.ID, MessageID: Hashed(messageID)}); err != nil || seeded {
		return "", 0, err
	}
	parsed, err := Content(raw)
	if err != nil {
		return "", 0, err
	}

	s := &syncer{ctx: ctx, pool: pool, store: store, progress: func(int64) {}, acc: acc, pub: pub}
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
	box, err := s.q.LocalMailbox(ctx, acc.ID)
	if errors.Is(err, pgx.ErrNoRows) {
		box = db.Mailbox{ID: rand.Text(), AccountID: acc.ID}
		if err = s.q.CreateLocalMailbox(ctx, db.CreateLocalMailboxParams{ID: box.ID, AccountID: acc.ID, Name: localName}); err == nil {
			s.log("mailbox", box.ID, "upsert")
		}
	}
	if err != nil {
		return "", 0, err
	}
	uid, err := s.q.MaxUID(ctx, box.ID)
	if err != nil {
		return "", 0, err
	}
	sent, err := h.Date()
	if err != nil || sent.IsZero() {
		sent = time.Now()
	}
	subject, _ := h.Subject()
	from, _ := h.AddressList("From")
	to, _ := h.AddressList("To")
	cc, _ := h.AddressList("Cc")
	row := db.InsertMessageParams{
		ID: rand.Text(), AccountID: acc.ID, MailboxID: box.ID, Uid: uid + 1, MessageID: Hashed(messageID),
		SentAt: pgtype.Timestamptz{Time: sent, Valid: true}, Flags: []string{}, Size: int32(len(raw)),
		// Meant to be seen, whatever its headers look like.
		Category: "primary", Refs: []string{},
	}
	meta := Meta{
		MessageID: messageID, Subject: subject, Snippet: parsed.Snippet, To: names(to), Cc: names(cc),
		Attachments: append([]File{}, parsed.Files...), Actions: append([]Action{}, parsed.Actions...),
		Rich: parsed.Rich != "", Seeded: true,
	}
	if len(from) > 0 {
		meta.FromName, meta.FromAddr = from[0].Name, from[0].Address
	}
	if err := s.keep(&row, meta, parsed); err != nil {
		return "", 0, err
	}
	if err := s.insert(&row); err != nil {
		return "", 0, err
	}
	if err := s.flush(); err != nil {
		return "", 0, err
	}
	return acc.ID, s.acc.Version, s.tx.Commit(ctx)
}

func names(list []*mail.Address) []string {
	out := make([]string, len(list))
	for i, a := range list {
		out[i] = a.Address
	}
	return out
}
