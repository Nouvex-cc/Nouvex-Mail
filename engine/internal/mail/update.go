// SPDX-License-Identifier: AGPL-3.0-only

package mail

import (
	"context"
	"slices"
	"strings"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapclient"

	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/db"
	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/msg"
	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/secret"
)

// Update applies a change the user made to one message on the server. The database follows with the next sync.
func Update(ctx context.Context, q *db.Queries, master []byte, cmd msg.MessageUpdate) error {
	acc, err := q.GetAccount(ctx, cmd.AccountId)
	if err != nil {
		return err
	}
	place, err := q.GetMessagePlace(ctx, db.GetMessagePlaceParams{ID: cmd.MessageId, AccountID: cmd.AccountId})
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
	if _, err := c.Select(place.Name, nil).Wait(); err != nil {
		return err
	}
	uid := imap.UIDSetNum(imap.UID(place.Uid))

	if cmd.Seen != nil {
		op := imap.StoreFlagsAdd
		if !*cmd.Seen {
			op = imap.StoreFlagsDel
		}
		if err := c.Store(uid, &imap.StoreFlags{Op: op, Silent: true, Flags: []imap.Flag{imap.FlagSeen}}, nil).Close(); err != nil {
			return err
		}
	}
	if cmd.Archive != nil && *cmd.Archive {
		archive, err := specialFolder(c, imap.MailboxAttrArchive, "Archive")
		if err != nil {
			return err
		}
		if archive == "" {
			archive = "Archive"
			if err := c.Create(archive, nil).Wait(); err != nil {
				return err
			}
		}
		if archive != place.Name {
			_, err = c.Move(uid, archive).Wait()
		}
		return err
	}
	if cmd.Trash != nil && *cmd.Trash {
		trash, err := specialFolder(c, imap.MailboxAttrTrash, "Trash")
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

// specialFolder finds the folder marked with attr, or one called name on servers without SPECIAL-USE.
func specialFolder(c *imapclient.Client, attr imap.MailboxAttr, name string) (string, error) {
	opts := &imap.ListOptions{ReturnSpecialUse: c.Caps().Has(imap.CapSpecialUse)}
	boxes, err := c.List("", "*", opts).Collect()
	if err != nil {
		return "", err
	}
	for _, b := range boxes {
		if slices.Contains(b.Attrs, attr) {
			return b.Mailbox, nil
		}
	}
	for _, b := range boxes {
		if strings.EqualFold(b.Mailbox, name) {
			return b.Mailbox, nil
		}
	}
	return "", nil
}
