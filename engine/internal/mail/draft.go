// SPDX-License-Identifier: AGPL-3.0-only

package mail

import (
	"context"
	"strings"
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

// SaveDraft stores a draft in the Drafts folder in place of its previous version, or only deletes it when discarded.
func SaveDraft(ctx context.Context, q *db.Queries, master []byte, cmd msg.DraftSave) error {
	acc, err := q.GetAccount(ctx, cmd.AccountId)
	if err != nil {
		return err
	}
	pass, err := secret.Open(master, acc.Secret)
	if err != nil {
		return err
	}
	c, err := DialIMAP(acc.ImapHost, int(acc.ImapPort), acc.Username, pass, nil)
	if err != nil {
		return err
	}
	defer func() { _ = c.Logout().Wait() }()
	drafts, err := specialFolder(c, "drafts", "Drafts")
	if err != nil {
		return err
	}
	id := draftID(cmd.DraftId, acc.Email)
	if err := removeDraft(c, drafts, id); err != nil {
		return err
	}
	if cmd.Discard != nil && *cmd.Discard {
		return nil
	}
	var parent string
	if cmd.InReplyTo != nil {
		parent, _ = q.GetMessageID(ctx, db.GetMessageIDParams{ID: *cmd.InReplyTo, AccountID: cmd.AccountId})
	}
	raw, err := Compose(mail.Address{Name: acc.DisplayName, Address: acc.Email}, msg.MessageSend{
		AccountId: cmd.AccountId, To: cmd.To, Cc: cmd.Cc, Bcc: cmd.Bcc, Subject: cmd.Subject, Text: cmd.Text,
	}, parent, id, nil, time.Now())
	if err != nil {
		return err
	}
	w := c.Append(drafts, int64(len(raw)), &imap.AppendOptions{Flags: []imap.Flag{imap.FlagDraft, imap.FlagSeen}})
	if _, err := w.Write(raw); err != nil {
		return err
	}
	if err := w.Close(); err != nil {
		return err
	}
	_, err = w.Wait()
	return err
}

// DiscardDraft deletes a draft, e.g. once it has been sent.
func DiscardDraft(ctx context.Context, q *db.Queries, master []byte, accountID, draft string) error {
	yes := true
	return SaveDraft(ctx, q, master, msg.DraftSave{AccountId: accountID, DraftId: draft, Discard: &yes})
}

func removeDraft(c *imapclient.Client, drafts, id string) error {
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
