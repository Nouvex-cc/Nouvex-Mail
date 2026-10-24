// SPDX-License-Identifier: AGPL-3.0-only

package mail

import (
	"context"
	"crypto/rand"
	"encoding/json"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapclient"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/db"
	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/msg"
	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/secret"
)

// Update applies a change the user made to one message on the server. Flags are saved in the database right away,
// from the server's answer; everything else follows with the next sync.
func Update(ctx context.Context, q *db.Queries, master []byte, cmd msg.MessageUpdate) (err error) {
	acc, err := q.GetAccount(ctx, cmd.AccountId)
	if err != nil {
		return err
	}
	place, err := q.GetMessagePlace(ctx, db.GetMessagePlaceParams{ID: cmd.MessageId, AccountID: cmd.AccountId})
	if err != nil {
		return err
	}
	if cmd.Category != nil || cmd.Spam != nil {
		sort := db.SortMessageParams{AccountID: cmd.AccountId, ID: cmd.MessageId}
		if cmd.Category != nil {
			sort.Category = pgtype.Text{String: string(*cmd.Category), Valid: true}
		}
		if cmd.Spam != nil {
			sort.Spam = pgtype.Bool{Bool: *cmd.Spam, Valid: true}
		}
		if err := q.SortMessage(ctx, sort); err != nil {
			return err
		}
	}
	if place.Local {
		return updateLocal(ctx, q, cmd, place.Flags)
	}
	// Only spam that sits in the inbox, or not spam that sits in the junk folder, moves on the server.
	if cmd.Spam != nil && *cmd.Spam == (place.Role == "junk") {
		cmd.Spam = nil
	}
	if Saved(cmd) && cmd.Seen == nil && cmd.Flagged == nil {
		return nil
	}
	pass, err := secret.Open(master, acc.Secret)
	if err != nil {
		return err
	}
	c, err := connect(acc, pass, true)
	if err != nil {
		return err
	}
	defer func() { release(acc, c, err) }()
	// Sent together with the commands below, which fail too if it does; its error says why.
	selected := c.Select(place.Name, nil)
	defer func() {
		if _, serr := selected.Wait(); serr != nil {
			err = serr
		}
	}()
	uid := imap.UIDSetNum(imap.UID(place.Uid))

	var stores []*imapclient.FetchCommand
	for flag, on := range map[imap.Flag]*bool{imap.FlagSeen: cmd.Seen, imap.FlagFlagged: cmd.Flagged} {
		if on == nil {
			continue
		}
		op := imap.StoreFlagsAdd
		if !*on {
			op = imap.StoreFlagsDel
		}
		// Not silent: the answer has the message's flags.
		stores = append(stores, c.Store(uid, &imap.StoreFlags{Op: op, Flags: []imap.Flag{flag}}, nil))
	}
	var flags []imap.Flag
	answered := false
	for _, s := range stores {
		msgs, err := s.Collect()
		if err != nil {
			return err
		}
		for _, m := range msgs {
			if m.UID == imap.UID(place.Uid) {
				flags, answered = m.Flags, true
			}
		}
	}
	if Saved(cmd) {
		if !answered {
			return nil
		}
		return q.SaveFlags(ctx, db.SaveFlagsParams{AccountID: cmd.AccountId, ID: cmd.MessageId, Flags: flagStrings(flags)})
	}
	if cmd.Spam != nil {
		// The flag tells the provider's filter too, the way other mail apps do it.
		flag, to := imap.Flag("$NotJunk"), "INBOX"
		if *cmd.Spam {
			flag = "$Junk"
			if to, err = specialFolder(c, "junk", ""); err != nil || to == "" {
				return err
			}
		}
		if err := c.Store(uid, &imap.StoreFlags{Op: imap.StoreFlagsAdd, Silent: true, Flags: []imap.Flag{flag}}, nil).Close(); err != nil {
			return err
		}
		_, err := c.Move(uid, to).Wait()
		return err
	}
	if cmd.Inbox != nil && *cmd.Inbox && place.Name != "INBOX" {
		_, err := c.Move(uid, "INBOX").Wait()
		return err
	}
	if cmd.SnoozeUntil != nil {
		// Snoozed is a folder on the server, so other mail apps see it too; a job brings it back.
		snoozed, err := specialFolder(c, "snoozed", "Snoozed")
		if err != nil {
			return err
		}
		messageID, err := q.GetMessageID(ctx, db.GetMessageIDParams{ID: cmd.MessageId, AccountID: cmd.AccountId})
		if err != nil {
			return err
		}
		payload, _ := json.Marshal(map[string]string{"messageId": messageID})
		if err := q.AddJob(ctx, db.AddJobParams{
			ID: rand.Text(), AccountID: cmd.AccountId, Kind: "unsnooze", Payload: payload,
			RunAt: pgtype.Timestamptz{Time: *cmd.SnoozeUntil, Valid: true},
		}); err != nil {
			return err
		}
		if snoozed != place.Name {
			_, err = c.Move(uid, snoozed).Wait()
		}
		return err
	}
	if cmd.Archive != nil && *cmd.Archive {
		archive, err := specialFolder(c, "archive", "Archive")
		if err != nil {
			return err
		}
		if archive != place.Name {
			_, err = c.Move(uid, archive).Wait()
		}
		return err
	}
	if cmd.Trash != nil && *cmd.Trash {
		trash, err := specialFolder(c, "trash", "")
		if err != nil {
			return err
		}
		if trash != "" && trash != place.Name {
			_, err = c.Move(uid, trash).Wait()
			return err
		}
		// No trash folder, or already in it: delete for good.
		if err := c.Store(uid, &imap.StoreFlags{Op: imap.StoreFlagsAdd, Silent: true, Flags: []imap.Flag{imap.FlagDeleted}}, nil).Close(); err != nil {
			return err
		}
		if c.Caps().Has(imap.CapUIDPlus) {
			return c.UIDExpunge(uid).Close()
		}
		return c.Expunge().Close()
	}
	return nil
}

// Saved tells whether Update saves the change in the database itself, so no sync is needed for it.
func Saved(cmd msg.MessageUpdate) bool {
	return cmd.Inbox == nil && cmd.SnoozeUntil == nil && cmd.Archive == nil && cmd.Trash == nil && cmd.Spam == nil
}

// specialFolder finds the folder with the given role, the same way Sync assigns roles. A missing one is created
// under create, unless that is empty.
func specialFolder(c *imapclient.Client, want, create string) (string, error) {
	boxes, err := c.List("", "*", &imap.ListOptions{ReturnSpecialUse: c.Caps().Has(imap.CapSpecialUse)}).Collect()
	if err != nil {
		return "", err
	}
	for _, b := range skipVirtual(boxes) {
		if role(b) == want {
			return b.Mailbox, nil
		}
	}
	if create == "" {
		return "", nil
	}
	return create, c.Create(create, nil).Wait()
}

// updateLocal changes mail that only lives in Nouvex, in the database alone: read and starred set its flags,
// archiving or deleting removes it. Snoozing doesn't apply.
// ponytail: a removed message's parts stay in the bucket until the engine's next start sweeps them.
func updateLocal(ctx context.Context, q *db.Queries, cmd msg.MessageUpdate, flags []string) error {
	if (cmd.Archive != nil && *cmd.Archive) || (cmd.Trash != nil && *cmd.Trash) {
		return q.DeleteLocalMessage(ctx, db.DeleteLocalMessageParams{ID: cmd.MessageId, AccountID: cmd.AccountId})
	}
	set := map[imap.Flag]bool{}
	for _, f := range flags {
		set[imap.Flag(f)] = true
	}
	for flag, on := range map[imap.Flag]*bool{imap.FlagSeen: cmd.Seen, imap.FlagFlagged: cmd.Flagged} {
		if on != nil {
			set[flag] = *on
		}
	}
	var next []imap.Flag
	for f, on := range set {
		if on {
			next = append(next, f)
		}
	}
	return q.SaveFlags(ctx, db.SaveFlagsParams{AccountID: cmd.AccountId, ID: cmd.MessageId, Flags: flagStrings(next)})
}
