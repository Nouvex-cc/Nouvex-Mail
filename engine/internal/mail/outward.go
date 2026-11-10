// SPDX-License-Identifier: AGPL-3.0-only

package mail

import (
	"context"
	"crypto/rand"
	"errors"
	"mime"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/db"
	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/mx"
)

// Outward sends a hosted account's mail to addresses outside Nouvex: Amazon SES now (internal/ses), our own servers
// later. tags travel with the message and come back with SES's bounce and complaint reports. Nil until set up.
// ponytail: package state set once at start, like here.
var Outward func(ctx context.Context, from string, to []string, raw []byte, tags map[string]string) error

// Arrival is mail a send put straight into a Nouvex mailbox, for the engine to tell that mailbox's clients.
type Arrival struct {
	AccountID string
	Version   int64
	Arrived   []string
}

// errNotSetUp is what a hosted account hears when the server can't send outside Nouvex yet.
var errNotSetUp = errors.New("sending outside Nouvex isn't set up on this server yet")

// sendHosted delivers a hosted account's message. Recipients Nouvex hosts get it straight into their inbox, sealed
// to their mailbox's key, without it going over the internet; that's remembered, so it can be taken back
// (Unsend). Everyone else gets it through Outward. A retry after a failure there doesn't double what went in
// already: the same Message-ID is stored once.
func sendHosted(ctx context.Context, acc db.MailAccount, from string, to []string, raw []byte, messageID string) ([]Arrival, error) {
	q := db.New(here.pool)
	var inside []Arrival
	var outside []string
	done := map[string]bool{}
	for _, r := range to {
		recipient, err := q.HostedAccount(ctx, mx.Address(r))
		if errors.Is(err, pgx.ErrNoRows) {
			outside = append(outside, r)
			continue
		}
		if err != nil {
			return inside, err
		}
		if done[recipient] {
			continue
		}
		done[recipient] = true
		rowID, version, arrived, err := deliver(ctx, here.pool, here.store, recipient, raw, false)
		if err != nil {
			return inside, err
		}
		if rowID != "" {
			if err := q.AddInternalDelivery(ctx, db.AddInternalDeliveryParams{
				SenderAccountID: acc.ID, MessageID: Hashed(messageID), RecipientAccountID: recipient, RecipientMessageID: rowID,
			}); err != nil {
				return inside, err
			}
		}
		inside = append(inside, Arrival{AccountID: recipient, Version: version, Arrived: arrived})
	}
	if len(outside) == 0 {
		return inside, nil
	}
	if Outward == nil {
		return inside, errNotSetUp
	}
	return inside, Outward(ctx, from, outside, raw, map[string]string{"account": acc.ID})
}

// sendingAddress is the address a message goes out from: the account's own, or one of its aliases if asked for.
func sendingAddress(ctx context.Context, q *db.Queries, acc db.MailAccount, asked *string) (string, error) {
	if asked == nil || *asked == "" || strings.EqualFold(*asked, acc.Email) {
		return acc.Email, nil
	}
	address := strings.ToLower(strings.TrimSpace(*asked))
	owner, err := q.AddressOwner(ctx, address)
	if acc.Kind != "hosted" || errors.Is(err, pgx.ErrNoRows) || (err == nil && owner != acc.ID) {
		return "", errors.New(address + " isn't an address of this mailbox")
	}
	return address, err
}

// Unsend takes a sent message back out of the Nouvex mailboxes it went into directly, and returns those mailboxes
// with their versions. What went out through Outward is gone and stays gone.
func Unsend(ctx context.Context, q *db.Queries, store Store, accountID, messageID string) ([]Arrival, error) {
	rows, err := q.TakeInternalDeliveries(ctx, db.TakeInternalDeliveriesParams{SenderAccountID: accountID, MessageID: Hashed(messageID)})
	if err != nil {
		return nil, err
	}
	var out []Arrival
	for _, r := range rows {
		if err := q.DeleteLocalMessage(ctx, db.DeleteLocalMessageParams{ID: r.RecipientMessageID, AccountID: r.RecipientAccountID}); err != nil {
			return out, err
		}
		if err := store.Drop(ctx, r.RecipientMessageID); err != nil {
			return out, err
		}
		acc, err := q.GetAccount(ctx, r.RecipientAccountID)
		if err != nil {
			return out, err
		}
		out = append(out, Arrival{AccountID: acc.ID, Version: acc.Version})
	}
	return out, nil
}

// Notify puts a message from Nouvex itself into a hosted account's inbox, like a bounce report, sealed to it.
func Notify(ctx context.Context, pool *pgxpool.Pool, store Store, accountID string, raw []byte) (Arrival, error) {
	q := db.New(pool)
	acc, err := q.GetAccount(ctx, accountID)
	if err != nil {
		return Arrival{}, err
	}
	pub, err := q.GetUserKey(ctx, acc.ID)
	if err != nil {
		return Arrival{}, err
	}
	s := &syncer{ctx: ctx, pool: pool, store: store, progress: func(int64, []string) {}, acc: acc, pub: pub}
	if err := s.begin(); err != nil {
		return Arrival{}, err
	}
	defer func() { _ = s.tx.Rollback(ctx) }()
	box, err := s.localBox("inbox", "Inbox")
	if err != nil {
		return Arrival{}, err
	}
	row, added, err := s.ingest(box, raw, arrival{flags: []string{}, seeded: true})
	if err != nil {
		return Arrival{}, err
	}
	if err := s.flush(); err != nil {
		return Arrival{}, err
	}
	if err := s.tx.Commit(ctx); err != nil {
		return Arrival{}, err
	}
	out := Arrival{AccountID: acc.ID, Version: s.acc.Version}
	if added {
		out.Arrived = []string{row.ID}
	}
	return out, nil
}

// Feedback is what SES reported about a sent message, as the API passes it on (sealed).
type Feedback struct {
	Kind       string `json:"kind"`
	Subject    string `json:"subject"`
	Recipients []struct {
		Address string `json:"address"`
		Reason  string `json:"reason"`
	} `json:"recipients"`
}

// Report is the message that tells a sender about a bounce or a spam complaint, in their own inbox.
func Report(to string, f Feedback) []byte {
	title := "Couldn't deliver: " + f.Subject
	intro := "Your message couldn't be delivered to:"
	if f.Kind == "complaint" {
		title = "Marked as spam: " + f.Subject
		intro = "Your message was marked as spam by:"
	}
	var b strings.Builder
	b.WriteString(intro + "\n\n")
	for _, r := range f.Recipients {
		b.WriteString("  " + r.Address)
		if r.Reason != "" {
			b.WriteString(" (" + r.Reason + ")")
		}
		b.WriteString("\n")
	}
	if f.Kind == "complaint" {
		b.WriteString("\nSending more mail they don't want can stop this mailbox from sending.\n")
	}
	return []byte("From: Nouvex <postmaster@nouvex.cc>\r\nTo: " + to + "\r\nSubject: " + mime.QEncoding.Encode("utf-8", title) +
		"\r\nMessage-ID: <" + rand.Text() + "@nouvex.cc>\r\nDate: " + time.Now().Format(time.RFC1123Z) +
		"\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n" +
		strings.ReplaceAll(b.String(), "\n", "\r\n"))
}
