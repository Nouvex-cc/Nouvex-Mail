// SPDX-License-Identifier: AGPL-3.0-only

package mail

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapclient"
	"github.com/emersion/go-message/mail"

	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/db"
	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/msg"
	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/secret"
)

// draftID is the Message-ID every version of a draft carries, so the next save finds the one it replaces.
func draftID(draft, email string) string {
	return "draft-" + draft + "@" + email[strings.LastIndex(email, "@")+1:]
}

// revs is the newest version saved of each draft: a save retried after a later one mustn't bring old text back.
// ponytail: in memory, a retry across a restart can still win; one draft's saves rarely span a restart.
var revs = struct {
	sync.Mutex
	m map[string]int
}{m: map[string]int{}}

// SaveDraft stores a draft in the Drafts folder in place of its previous version, or only deletes it when discarded.
// A draft that is on its way out, or went, isn't stored again. files says where its attachments are kept.
func SaveDraft(ctx context.Context, q *db.Queries, get Get, master []byte, cmd msg.DraftSave, files string) (err error) {
	discard := cmd.Discard != nil && *cmd.Discard
	if !discard {
		if state, err := q.SendState(ctx, cmd.DraftId); err == nil && state != "failed" {
			return nil
		}
		if cmd.Rev != nil {
			revs.Lock()
			old := revs.m[cmd.DraftId]
			if *cmd.Rev >= old {
				revs.m[cmd.DraftId] = *cmd.Rev
			}
			revs.Unlock()
			if *cmd.Rev < old {
				return nil
			}
		}
	}
	acc, err := q.GetAccount(ctx, cmd.AccountId)
	if err != nil {
		return err
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
	drafts, err := specialFolder(c, "drafts", "Drafts")
	if err != nil {
		return err
	}
	id := draftID(cmd.DraftId, acc.Email)
	if discard {
		return removeDraft(c, drafts, id, false, 0)
	}
	attached := make([]File, len(cmd.Attachments))
	for i, a := range cmd.Attachments {
		data, err := get(ctx, files+a.Id)
		if err != nil {
			return fmt.Errorf("attachment %s: %w", a.Name, err)
		}
		attached[i] = File{Name: a.Name, Type: a.Type, Data: data}
	}
	raw, err := Compose(mail.Address{Name: acc.DisplayName, Address: acc.Email}, msg.MessageSend{
		AccountId: cmd.AccountId, DraftId: cmd.DraftId, To: cmd.To, Cc: cmd.Cc, Bcc: cmd.Bcc, Subject: cmd.Subject,
		Text: cmd.Text, Html: cmd.Html, InReplyTo: cmd.InReplyTo,
	}, id, attached, time.Now(), true)
	if err != nil {
		return err
	}
	// The new version first, then the old ones go: a save that fails halfway leaves the draft as it was.
	w := c.Append(drafts, int64(len(raw)), &imap.AppendOptions{Flags: []imap.Flag{imap.FlagDraft, imap.FlagSeen}})
	if _, err := w.Write(raw); err != nil {
		return err
	}
	if err := w.Close(); err != nil {
		return err
	}
	added, err := w.Wait()
	if err != nil {
		return err
	}
	return removeDraft(c, drafts, id, true, added.UID)
}

// DiscardDraft deletes a draft, e.g. once it has been sent.
func DiscardDraft(ctx context.Context, q *db.Queries, master []byte, accountID, draft string) error {
	yes := true
	return SaveDraft(ctx, q, nil, master, msg.DraftSave{AccountId: accountID, DraftId: draft, Discard: &yes}, "")
}

// Restore puts a message that couldn't be sent back into Drafts, as it was written.
func Restore(ctx context.Context, q *db.Queries, get Get, master []byte, cmd msg.MessageSend, files string) error {
	return SaveDraft(ctx, q, get, master, msg.DraftSave{
		AccountId: cmd.AccountId, DraftId: cmd.DraftId, To: cmd.To, Cc: cmd.Cc, Bcc: cmd.Bcc, Subject: cmd.Subject,
		Text: cmd.Text, Html: cmd.Html, InReplyTo: cmd.InReplyTo, Attachments: draftFiles(cmd.Attachments),
	}, files)
}

// removeDraft deletes every version of a draft, or all but the one just added (fresh): the one with the UID keep, or
// the newest when the server didn't say which UID it gave.
func removeDraft(c *imapclient.Client, drafts, id string, fresh bool, keep imap.UID) error {
	sel, err := c.Select(drafts, nil).Wait()
	if err != nil || sel.NumMessages == 0 {
		return err
	}
	// Read every draft's Message-ID instead of SEARCH: some servers (Purelymail) index a message a while after
	// APPEND, so a draft saved seconds before sending wasn't found and stayed behind.
	// ponytail: reads the envelopes of the whole Drafts folder; fine while it holds tens, not thousands.
	var all imap.UIDSet
	all.AddRange(1, 0)
	msgs, err := c.Fetch(all, &imap.FetchOptions{UID: true, Envelope: true}).Collect()
	if err != nil {
		return err
	}
	var uids []imap.UID
	for _, m := range msgs {
		if m.Envelope != nil && m.Envelope.MessageID == id {
			uids = append(uids, m.UID)
		}
	}
	slices.Sort(uids)
	if fresh && keep == 0 && len(uids) > 0 {
		keep = uids[len(uids)-1]
	}
	uids = slices.DeleteFunc(uids, func(u imap.UID) bool { return u == keep })
	if len(uids) == 0 {
		return nil
	}
	set := imap.UIDSetNum(uids...)
	if err := c.Store(set, &imap.StoreFlags{Op: imap.StoreFlagsAdd, Silent: true, Flags: []imap.Flag{imap.FlagDeleted}}, nil).Close(); err != nil {
		return err
	}
	if c.Caps().Has(imap.CapUIDPlus) {
		return c.UIDExpunge(set).Close()
	}
	return c.Expunge().Close()
}

func draftFiles(list []msg.MessageSendAttachmentsElem) []msg.DraftSaveAttachmentsElem {
	out := make([]msg.DraftSaveAttachmentsElem, len(list))
	for i, a := range list {
		out[i] = msg.DraftSaveAttachmentsElem(a)
	}
	return out
}
