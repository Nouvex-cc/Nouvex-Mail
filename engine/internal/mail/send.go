// SPDX-License-Identifier: AGPL-3.0-only

package mail

import (
	"bytes"
	"context"
	"errors"
	"io"
	"slices"
	"strings"
	"time"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-message/mail"

	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/db"
	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/msg"
	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/secret"
)

// Compose builds a plain text message, multipart with files if there are any. Bcc recipients get it through the
// envelope only. parent is the Message-ID of the message this answers, or empty.
// ponytail: References holds only the parent; the parent's own References would need its raw headers.
func Compose(from string, cmd msg.MessageSend, parent string, files []File, now time.Time) ([]byte, error) {
	var h mail.Header
	h.SetDate(now)
	h.SetSubject(cmd.Subject)
	h.SetAddressList("From", []*mail.Address{{Address: from}})
	for field, list := range map[string][]string{"To": cmd.To, "Cc": cmd.Cc} {
		if len(list) == 0 {
			continue
		}
		addrs := make([]*mail.Address, len(list))
		for i, a := range list {
			addrs[i] = &mail.Address{Address: a}
		}
		h.SetAddressList(field, addrs)
	}
	if parent != "" {
		h.SetMsgIDList("In-Reply-To", []string{parent})
		h.SetMsgIDList("References", []string{parent})
	}
	if err := h.GenerateMessageIDWithHostname(from[strings.LastIndex(from, "@")+1:]); err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	if len(files) == 0 {
		h.SetContentType("text/plain", map[string]string{"charset": "utf-8"})
		w, err := mail.CreateSingleInlineWriter(&buf, h)
		if err != nil {
			return nil, err
		}
		if err := errors.Join(write(w, []byte(cmd.Text)), w.Close()); err != nil {
			return nil, err
		}
		return buf.Bytes(), nil
	}
	w, err := mail.CreateWriter(&buf, h)
	if err != nil {
		return nil, err
	}
	var th mail.InlineHeader
	th.SetContentType("text/plain", map[string]string{"charset": "utf-8"})
	tw, err := w.CreateSingleInline(th)
	if err != nil {
		return nil, err
	}
	if err := errors.Join(write(tw, []byte(cmd.Text)), tw.Close()); err != nil {
		return nil, err
	}
	for _, f := range files {
		var ah mail.AttachmentHeader
		ah.SetContentType(f.Type, nil)
		ah.SetFilename(f.Name)
		aw, err := w.CreateAttachment(ah)
		if err != nil {
			return nil, err
		}
		if err := errors.Join(write(aw, f.Data), aw.Close()); err != nil {
			return nil, err
		}
	}
	if err := w.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func write(w io.Writer, b []byte) error {
	_, err := w.Write(b)
	return err
}

// Get loads an object, e.g. from S3.
type Get func(ctx context.Context, key string) ([]byte, error)

// Send delivers the message over SMTP and returns it, for SaveSent.
func Send(ctx context.Context, q *db.Queries, get Get, master []byte, cmd msg.MessageSend) ([]byte, error) {
	acc, err := q.GetAccount(ctx, cmd.AccountId)
	if err != nil {
		return nil, err
	}
	pass, err := secret.Open(master, acc.Secret)
	if err != nil {
		return nil, err
	}
	var parent string
	if cmd.InReplyTo != nil {
		// A parent that is gone by now just means no thread headers.
		parent, _ = q.GetMessageID(ctx, db.GetMessageIDParams{ID: *cmd.InReplyTo, AccountID: cmd.AccountId})
	}
	files := make([]File, len(cmd.Attachments))
	for i, a := range cmd.Attachments {
		// The key is built here, so a command can only reach uploads of its own account.
		data, err := get(ctx, "upload/"+cmd.AccountId+"/"+a.Id)
		if err != nil {
			return nil, err
		}
		files[i] = File{Name: a.Name, Type: a.Type, Data: data}
	}
	raw, err := Compose(acc.Email, cmd, parent, files, time.Now())
	if err != nil {
		return nil, err
	}
	c, err := DialSMTP(acc.SmtpHost, int(acc.SmtpPort), acc.Username, pass)
	if err != nil {
		return nil, err
	}
	defer func() { _ = c.Close() }()
	if err := c.SendMail(acc.Email, slices.Concat(cmd.To, cmd.Cc, cmd.Bcc), bytes.NewReader(raw)); err != nil {
		return nil, err
	}
	return raw, c.Quit()
}

// SaveSent appends a sent message to the folder marked \Sent, or to one named Sent, which is created if needed.
func SaveSent(ctx context.Context, q *db.Queries, master []byte, accountID string, raw []byte) error {
	acc, err := q.GetAccount(ctx, accountID)
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
	sent, err := specialFolder(c, imap.MailboxAttrSent, "Sent")
	if err != nil {
		return err
	}
	if sent == "" {
		sent = "Sent"
		if err := c.Create(sent, nil).Wait(); err != nil {
			return err
		}
	}
	w := c.Append(sent, int64(len(raw)), &imap.AppendOptions{Flags: []imap.Flag{imap.FlagSeen}})
	if _, err := w.Write(raw); err != nil {
		return err
	}
	if err := w.Close(); err != nil {
		return err
	}
	_, err = w.Wait()
	return err
}
