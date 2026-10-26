// SPDX-License-Identifier: AGPL-3.0-only

package mail

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/db"
	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/msg"
	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/secret"
)

// Files is where a message's attachments are kept, e.g. the bucket.
type Files struct {
	Get    Get
	Put    func(ctx context.Context, key string, data []byte, contentType string) error
	Remove func(ctx context.Context, key string) error
}

// Retries is how long a message waits before its next try, by how often it was tried. The consumer delivers a
// command five times at most; the try after the last of these gives up.
var Retries = []time.Duration{time.Minute, 5 * time.Minute, 15 * time.Minute, 15 * time.Minute}

// Outcome is what became of a send command: Retry says to bring it again after that long, else it's done and Event
// tells the clients. Resync is set when the account's folders changed.
type Outcome struct {
	Retry  time.Duration
	Event  msg.MessageSent
	Resync bool
}

// Deliver gets a message out once. The outbox row of its draft lets a command that comes again (a restart, a
// redelivery, a client trying again) through only as long as the message hasn't gone. A server that can't be
// reached is tried again; a message that can't go comes back to Drafts, and the event says why. tries counts this
// one. An error means nothing happened and the command should come again.
func Deliver(ctx context.Context, q *db.Queries, files Files, master []byte, cmd msg.MessageSend, tries int) (Outcome, error) {
	out := Outcome{Event: msg.MessageSent{AccountId: cmd.AccountId, DraftId: cmd.DraftId}}
	// The account was removed meanwhile: nothing to send from, nothing to try again.
	if _, err := q.GetAccount(ctx, cmd.AccountId); errors.Is(err, pgx.ErrNoRows) {
		gone := "The account it was to go out from is gone."
		out.Event.Error = &gone
		return out, nil
	}
	// Out of upload/, which is swept after a day, to where the files wait as long as the message does.
	kept := "outbox/" + cmd.DraftId + "/"
	if err := hold(ctx, files, cmd, kept); err != nil {
		return Outcome{}, err
	}

	if cmd.SendAt != nil && cmd.SendAt.After(time.Now()) {
		at := *cmd.SendAt
		cmd.SendAt = nil
		plain, _ := json.Marshal(cmd)
		n, err := q.ScheduleSend(ctx, db.ScheduleSendParams{
			DraftID: cmd.DraftId, AccountID: cmd.AccountId, RunAt: pgtype.Timestamptz{Time: at, Valid: true},
			Payload: secret.Seal(master, plain),
		})
		if err != nil {
			return Outcome{}, err
		}
		if n > 0 {
			// It waits in the outbox now, not in Drafts, where sending it again would send it twice.
			if err := DiscardDraft(ctx, q, master, cmd.AccountId, cmd.DraftId); err != nil {
				slog.Warn("removing the draft failed", "account", cmd.AccountId, "err", err)
			}
			yes := true
			out.Event.Scheduled = &yes
			out.Resync = true
		}
		return out, nil
	}

	plain, _ := json.Marshal(cmd)
	_, err := q.StartSend(ctx, db.StartSendParams{DraftID: cmd.DraftId, AccountID: cmd.AccountId, Payload: secret.Seal(master, plain)})
	if errors.Is(err, pgx.ErrNoRows) {
		// Gone already; this is the same command once more.
		return out, nil
	}
	if err != nil {
		return Outcome{}, err
	}
	sent, err := Send(ctx, q, files.Get, master, cmd, kept)
	if !sent.Taken {
		if Temporary(err) && tries <= len(Retries) {
			slog.Warn("send failed, trying again", "account", cmd.AccountId, "try", tries, "err", err)
			return Outcome{Retry: Retries[tries-1]}, nil
		}
		reason := Reason(err)
		slog.Error("send failed", "account", cmd.AccountId, "err", err)
		if err := q.EndSend(ctx, db.EndSendParams{DraftID: cmd.DraftId, State: "failed", Error: pgtype.Text{String: reason, Valid: true}}); err != nil {
			return Outcome{}, err
		}
		if Login(err) {
			_ = q.SetSyncError(ctx, db.SetSyncErrorParams{ID: cmd.AccountId, SyncError: pgtype.Text{String: reason, Valid: true}})
		}
		if err := Restore(ctx, q, files.Get, master, cmd, kept); err != nil {
			slog.Error("putting the message back into Drafts failed", "account", cmd.AccountId, "err", err)
		} else {
			letGo(ctx, files, cmd, kept)
		}
		out.Event.Error = &reason
		out.Resync = true
		return out, nil
	}
	if err := q.EndSend(ctx, db.EndSendParams{DraftID: cmd.DraftId, State: "sent"}); err != nil {
		slog.Error("outbox", "account", cmd.AccountId, "err", err)
	}
	if err := DiscardDraft(ctx, q, master, cmd.AccountId, cmd.DraftId); err != nil {
		slog.Warn("removing the draft failed", "account", cmd.AccountId, "err", err)
	}
	if err := SaveSent(ctx, q, master, cmd.AccountId, sent.Copy); err != nil {
		slog.Warn("saving to Sent failed", "account", cmd.AccountId, "err", err)
	}
	letGo(ctx, files, cmd, kept)
	// So the copy shows up in Sent and the draft leaves Drafts.
	out.Resync = true
	return out, nil
}

// hold moves a message's uploads to where they stay until it's sent; done before, they're there already.
func hold(ctx context.Context, files Files, cmd msg.MessageSend, kept string) error {
	for _, a := range cmd.Attachments {
		if _, err := files.Get(ctx, kept+a.Id); err == nil {
			continue
		}
		data, err := files.Get(ctx, "upload/"+cmd.AccountId+"/"+a.Id)
		if err != nil {
			return err
		}
		if err := files.Put(ctx, kept+a.Id, data, a.Type); err != nil {
			return err
		}
		_ = files.Remove(ctx, "upload/"+cmd.AccountId+"/"+a.Id)
	}
	return nil
}

func letGo(ctx context.Context, files Files, cmd msg.MessageSend, kept string) {
	for _, a := range cmd.Attachments {
		_ = files.Remove(ctx, kept+a.Id)
	}
}
