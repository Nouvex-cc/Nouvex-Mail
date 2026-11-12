// SPDX-License-Identifier: AGPL-3.0-only

package mail

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/emersion/go-imap/v2"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/db"
	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/msg"
)

// Hosted accounts keep their mail only with us: our MX receives it, and what the IMAP path does on a server (moving,
// Drafts, Sent) happens in the database instead. Their folders are local, one per role.
var hostedBoxes = []struct{ role, name string }{
	{"inbox", "Inbox"}, {"drafts", "Drafts"}, {"sent", "Sent"}, {"archive", "Archive"},
	{"snoozed", "Snoozed"}, {"junk", "Junk"}, {"trash", "Trash"},
}

// here is where hosted mail is kept: the engine's database and bucket.
// ponytail: package state set once at start, as the engine has one of each; pass it along if that changes.
var here struct {
	pool  *pgxpool.Pool
	store Store
}

// KeepHostedIn tells the package where hosted accounts' Drafts and Sent are stored.
func KeepHostedIn(pool *pgxpool.Pool, store Store) { here.pool, here.store = pool, store }

// provision makes sure a hosted account has all its folders, and returns its version; it's what a sync is for one.
func provision(ctx context.Context, pool *pgxpool.Pool, store Store, acc db.MailAccount, pub []byte) (int64, error) {
	s := &syncer{ctx: ctx, pool: pool, store: store, progress: func(int64, []string) {}, acc: acc, pub: pub}
	if err := s.begin(); err != nil {
		return 0, err
	}
	defer func() { _ = s.tx.Rollback(ctx) }()
	for _, b := range hostedBoxes {
		if _, err := s.localBox(b.role, b.name); err != nil {
			return 0, err
		}
	}
	if err := s.flush(); err != nil {
		return 0, err
	}
	return s.acc.Version, s.tx.Commit(ctx)
}

// localBox finds the account's local folder with a role, made under name when it's missing. Without a role, it's
// a folder of the user's own (an imported one), found by name.
func (s *syncer) localBox(role, name string) (db.Mailbox, error) {
	var box db.Mailbox
	var err error
	if role == "" {
		box, err = s.q.LocalMailboxNamed(s.ctx, db.LocalMailboxNamedParams{AccountID: s.acc.ID, Name: name})
	} else {
		box, err = s.q.LocalMailbox(s.ctx, db.LocalMailboxParams{AccountID: s.acc.ID, Role: role})
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return box, err
	}
	box = db.Mailbox{ID: rand.Text(), AccountID: s.acc.ID, Name: name, Role: role, Local: true}
	if err := s.q.CreateLocalMailbox(s.ctx, db.CreateLocalMailboxParams{ID: box.ID, AccountID: s.acc.ID, Name: name, Role: role}); err != nil {
		return box, err
	}
	s.log("mailbox", box.ID, "upsert")
	return box, nil
}

// storeHosted puts a message into a hosted account's folder for role. Earlier messages there with the Message-ID
// replaces go first (a draft's previous versions); without raw that is all it does (a discarded draft).
func storeHosted(ctx context.Context, acc db.MailAccount, role, replaces string, raw []byte, flags ...imap.Flag) error {
	if here.pool == nil {
		return errors.New("hosted mail has nowhere to go: KeepHostedIn wasn't called")
	}
	pub, err := db.New(here.pool).GetUserKey(ctx, acc.ID)
	if err != nil {
		return err
	}
	s := &syncer{ctx: ctx, pool: here.pool, store: here.store, progress: func(int64, []string) {}, acc: acc, pub: pub}
	if err := s.begin(); err != nil {
		return err
	}
	defer func() { _ = s.tx.Rollback(ctx) }()
	name := role
	for _, b := range hostedBoxes {
		if b.role == role {
			name = b.name
		}
	}
	box, err := s.localBox(role, name)
	if err != nil {
		return err
	}
	if replaces != "" {
		ids, err := s.q.DeleteByMessageID(ctx, db.DeleteByMessageIDParams{MailboxID: box.ID, MessageID: Hashed(replaces)})
		if err != nil {
			return err
		}
		if err := s.forget(ids); err != nil {
			return err
		}
	}
	if raw != nil {
		if _, _, err := s.ingest(box, raw, arrival{flags: flagStrings(flags)}); err != nil {
			return err
		}
	}
	if err := s.flush(); err != nil {
		return err
	}
	return s.tx.Commit(ctx)
}

// moveHosted does in the database what the IMAP path does on a server: the message goes to the folder for what
// was asked (spam, back to the inbox, snoozed, archived, deleted). Deleting from the trash deletes for good.
func moveHosted(ctx context.Context, q *db.Queries, cmd msg.MessageUpdate, role string) error {
	to := ""
	switch {
	case cmd.Spam != nil:
		// Only spam outside the junk folder, or not spam inside it, moves.
		if *cmd.Spam != (role == "junk") {
			to = map[bool]string{true: "junk", false: "inbox"}[*cmd.Spam]
		}
	case cmd.Inbox != nil && *cmd.Inbox:
		to = "inbox"
	case cmd.SnoozeUntil != nil:
		to = "snoozed"
		hashed, err := q.GetMessageID(ctx, db.GetMessageIDParams{ID: cmd.MessageId, AccountID: cmd.AccountId})
		if err != nil {
			return err
		}
		payload, _ := json.Marshal(map[string]string{"messageId": hashed})
		if err := q.AddJob(ctx, db.AddJobParams{
			ID: rand.Text(), AccountID: cmd.AccountId, Kind: "unsnooze", Payload: payload,
			RunAt: pgtype.Timestamptz{Time: *cmd.SnoozeUntil, Valid: true},
		}); err != nil {
			return err
		}
	case cmd.Archive != nil && *cmd.Archive:
		to = "archive"
	case cmd.Trash != nil && *cmd.Trash:
		if role == "trash" {
			// ponytail: its parts stay in the bucket until the engine's next start sweeps them.
			return q.DeleteLocalMessage(ctx, db.DeleteLocalMessageParams{ID: cmd.MessageId, AccountID: cmd.AccountId})
		}
		to = "trash"
	}
	if to == "" || to == role {
		return nil
	}
	if err := q.MoveLocalMessage(ctx, db.MoveLocalMessageParams{AccountID: cmd.AccountId, Role: to, ID: cmd.MessageId}); err != nil {
		return fmt.Errorf("move to %s: %w", to, err)
	}
	return nil
}
