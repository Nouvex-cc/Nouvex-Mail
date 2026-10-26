// SPDX-License-Identifier: AGPL-3.0-only

package mail

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"slices"
	"strings"
	"time"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-message/mail"
	"github.com/emersion/go-smtp"

	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/db"
	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/msg"
	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/secret"
)

// Compose builds a message: its text, and next to it its HTML if there is any, with the files attached. bcc puts the
// Bcc header in, for the copies kept in Sent and Drafts; what goes out has them in the envelope only. id is the
// Message-ID, or empty for a new one.
func Compose(from mail.Address, cmd msg.MessageSend, id string, files []File, now time.Time, bcc bool) ([]byte, error) {
	var h mail.Header
	h.SetDate(now)
	h.SetSubject(cmd.Subject)
	h.SetAddressList("From", []*mail.Address{&from})
	set := func(field string, list []string) {
		if len(list) > 0 {
			h.SetAddressList(field, addresses(list))
		}
	}
	set("To", cmd.To)
	set("Cc", cmd.Cc)
	if bcc {
		set("Bcc", cmd.Bcc)
	}
	if cmd.InReplyTo != nil && msgID(*cmd.InReplyTo) != "" {
		parent := msgID(*cmd.InReplyTo)
		h.SetMsgIDList("In-Reply-To", []string{parent})
		var refs []string
		for _, r := range cmd.References {
			if r = msgID(r); r != "" && r != parent && !slices.Contains(refs, r) {
				refs = append(refs, r)
			}
		}
		h.SetMsgIDList("References", append(refs, parent))
	}
	if id != "" {
		h.SetMessageID(id)
	} else if err := h.GenerateMessageIDWithHostname(domain(from.Address)); err != nil {
		return nil, err
	}

	var buf bytes.Buffer
	text := func(w io.Writer) error { return write(w, []byte(cmd.Text)) }
	// The text alone, or text and HTML as alternatives of each other.
	body := func(create func(mail.InlineHeader) (io.WriteCloser, error)) error {
		var th mail.InlineHeader
		th.SetContentType("text/plain", map[string]string{"charset": "utf-8"})
		tw, err := create(th)
		if err != nil {
			return err
		}
		if err := errors.Join(text(tw), tw.Close()); err != nil {
			return err
		}
		if cmd.Html == nil {
			return nil
		}
		var hh mail.InlineHeader
		hh.SetContentType("text/html", map[string]string{"charset": "utf-8"})
		hw, err := create(hh)
		if err != nil {
			return err
		}
		return errors.Join(write(hw, []byte(*cmd.Html)), hw.Close())
	}

	if len(files) == 0 && cmd.Html == nil {
		h.SetContentType("text/plain", map[string]string{"charset": "utf-8"})
		w, err := mail.CreateSingleInlineWriter(&buf, h)
		if err != nil {
			return nil, err
		}
		if err := errors.Join(text(w), w.Close()); err != nil {
			return nil, err
		}
		return buf.Bytes(), nil
	}
	if len(files) == 0 {
		w, err := mail.CreateInlineWriter(&buf, h)
		if err != nil {
			return nil, err
		}
		if err := errors.Join(body(func(ih mail.InlineHeader) (io.WriteCloser, error) { return w.CreatePart(ih) }), w.Close()); err != nil {
			return nil, err
		}
		return buf.Bytes(), nil
	}
	w, err := mail.CreateWriter(&buf, h)
	if err != nil {
		return nil, err
	}
	if cmd.Html == nil {
		err = body(func(ih mail.InlineHeader) (io.WriteCloser, error) { return w.CreateSingleInline(ih) })
	} else {
		iw, e := w.CreateInline()
		if e != nil {
			return nil, e
		}
		err = errors.Join(body(func(ih mail.InlineHeader) (io.WriteCloser, error) { return iw.CreatePart(ih) }), iw.Close())
	}
	if err != nil {
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

// addresses reads "Lena <lena@x.example>" as well as a bare address.
func addresses(list []string) []*mail.Address {
	out := make([]*mail.Address, len(list))
	for i, a := range list {
		if p, err := mail.ParseAddress(a); err == nil {
			out[i] = p
		} else {
			out[i] = &mail.Address{Address: strings.TrimSpace(a)}
		}
	}
	return out
}

// msgID is a Message-ID without its angle brackets, or empty if it can't be one.
func msgID(s string) string {
	s = strings.Trim(strings.TrimSpace(s), "<>")
	if s == "" || strings.ContainsAny(s, "\r\n <>") {
		return ""
	}
	return s
}

func domain(address string) string { return address[strings.LastIndex(address, "@")+1:] }

// SendID is the Message-ID a draft goes out with: the same on every try, so a copy that got through twice anyway
// shows up once.
func SendID(draftID, from string) string { return draftID + "@" + domain(from) }

func write(w io.Writer, b []byte) error {
	_, err := w.Write(b)
	return err
}

// Get loads an object, e.g. from S3.
type Get func(ctx context.Context, key string) ([]byte, error)

// Sent is what Send did: whether the server took the message, and the copy to keep in Sent.
type Sent struct {
	Taken bool
	Copy  []byte
}

// Send delivers the message over SMTP. Once the server has taken it, a failing goodbye doesn't make it unsent:
// Taken is set then, whatever the error says. files says where the attachments are kept.
func Send(ctx context.Context, q *db.Queries, get Get, master []byte, cmd msg.MessageSend, files string) (Sent, error) {
	acc, err := q.GetAccount(ctx, cmd.AccountId)
	if err != nil {
		return Sent{}, err
	}
	pass, err := secret.Open(master, acc.Secret)
	if err != nil {
		return Sent{}, err
	}
	attached := make([]File, len(cmd.Attachments))
	for i, a := range cmd.Attachments {
		// The key is built here, so a command can only reach files of its own account or draft.
		data, err := get(ctx, files+a.Id)
		if err != nil {
			return Sent{}, fmt.Errorf("attachment %s: %w", a.Name, err)
		}
		attached[i] = File{Name: a.Name, Type: a.Type, Data: data}
	}
	from := mail.Address{Name: acc.DisplayName, Address: acc.Email}
	now := time.Now()
	id := SendID(cmd.DraftId, acc.Email)
	raw, err := Compose(from, cmd, id, attached, now, false)
	if err != nil {
		return Sent{}, err
	}
	kept, err := Compose(from, cmd, id, attached, now, true)
	if err != nil {
		return Sent{}, err
	}
	c, err := DialSMTP(acc.SmtpHost, int(acc.SmtpPort), acc.Username, pass)
	if err != nil {
		return Sent{}, err
	}
	defer func() { _ = c.Close() }()
	if err := c.SendMail(acc.Email, envelope(slices.Concat(cmd.To, cmd.Cc, cmd.Bcc)), bytes.NewReader(raw)); err != nil {
		return Sent{}, err
	}
	_ = c.Quit()
	return Sent{Taken: true, Copy: kept}, nil
}

// envelope is the bare addresses of a recipient list.
func envelope(list []string) []string {
	var out []string
	for _, a := range addresses(list) {
		if !slices.ContainsFunc(out, func(b string) bool { return strings.EqualFold(a.Address, b) }) {
			out = append(out, a.Address)
		}
	}
	return out
}

// Temporary tells whether trying again later may work: the server said so (4xx), or it couldn't be reached.
func Temporary(err error) bool {
	var se *smtp.SMTPError
	if errors.As(err, &se) {
		return se.Code >= 400 && se.Code < 500
	}
	var ne net.Error
	return errors.As(err, &ne) || errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF)
}

// Reason says in words why a message couldn't be sent, for the user.
func Reason(err error) string {
	var se *smtp.SMTPError
	switch {
	case Login(err):
		return "The mail server didn't accept the account's password. Check it in the account's settings."
	case errors.As(err, &se) && (se.Code == 550 || se.Code == 551 || se.Code == 553):
		return "The mail server refused a recipient: " + se.Message
	case errors.As(err, &se) && se.Code == 552:
		return "The message is too large for the mail server."
	case errors.As(err, &se):
		return "The mail server refused the message: " + se.Message
	case Temporary(err):
		return "The mail server couldn't be reached."
	}
	return "The message couldn't be sent: " + err.Error()
}

// Login tells whether err is the server refusing the account's password.
func Login(err error) bool {
	var se *smtp.SMTPError
	return errors.As(err, &se) && (se.Code == 535 || se.Code == 534 || se.Code == 530)
}

// keepsSent tells servers that file what goes out through them in Sent themselves; a copy of ours would be a second.
func keepsSent(smtpHost string) bool {
	h := strings.ToLower(smtpHost)
	return strings.HasSuffix(h, "gmail.com") || strings.HasSuffix(h, "googlemail.com") ||
		strings.HasSuffix(h, "office365.com") || strings.HasSuffix(h, "outlook.com")
}

// SaveSent appends a sent message to the folder marked \Sent, or to one named Sent, which is created if needed.
// Servers that keep their own copy get none.
func SaveSent(ctx context.Context, q *db.Queries, master []byte, accountID string, raw []byte) (err error) {
	acc, err := q.GetAccount(ctx, accountID)
	if err != nil || keepsSent(acc.SmtpHost) {
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
	sent, err := specialFolder(c, "sent", "Sent")
	if err != nil {
		return err
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
