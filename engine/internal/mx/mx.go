// SPDX-License-Identifier: AGPL-3.0-only

// Package mx receives mail for the mailboxes Nouvex hosts. It knows no mail: a message is checked by rspamd, waits
// sealed with SECRETS_KEY in the bucket and is handed to the engine over NATS, which seals it to its mailbox's key.
// Only once both are stored does the sender get its 250, so a node can stop at any time and holds nothing.
package mx

import (
	"bytes"
	"context"
	"crypto/rand"
	"fmt"
	"io"
	"log/slog"
	"net"
	"slices"
	"strings"
	"time"

	"github.com/emersion/go-smtp"

	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/msg"
	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/secret"
)

// Envelope is what the sender said around a message, for the filter.
type Envelope struct {
	IP, Helo, From string
	To             []string
}

// Verdict is the filter's answer: rspamd's action, the headers it adds (Authentication-Results), and the ones the
// message brought that have to go, so a sender can't claim its own DKIM passed.
type Verdict struct {
	Action  string
	Headers []string
	Remove  []string
}

// Deps is everything the MX needs from outside, so it runs in tests without a database, bucket or NATS.
type Deps struct {
	// Hostname names this server in its greeting and Received headers.
	Hostname string
	// Lookup finds the hosted account an address belongs to; "" for none.
	Lookup func(ctx context.Context, address string) (string, error)
	// Check asks the filter; nil takes everything (development without rspamd).
	Check func(ctx context.Context, raw []byte, env Envelope) (Verdict, error)
	// Spool keeps a message, sealed, until the engine has stored it.
	Spool func(ctx context.Context, key string, sealed []byte) error
	// Deliver hands it to the engine and returns once NATS has it. id makes a retry not deliver twice.
	Deliver func(ctx context.Context, d msg.MailDeliver, id string) error
	Master  []byte
}

// Server is an SMTP server for port 25 on top of deps.
func Server(deps Deps, addr string) *smtp.Server {
	s := smtp.NewServer(backend{deps})
	s.Addr = addr
	s.Domain = deps.Hostname
	// SES and most providers stop at 40 MB too.
	s.MaxMessageBytes = 40 << 20
	s.MaxRecipients = 100
	s.ReadTimeout = 5 * time.Minute
	s.WriteTimeout = time.Minute
	s.EnableSMTPUTF8 = true
	return s
}

type backend struct{ Deps }

func (b backend) NewSession(c *smtp.Conn) (smtp.Session, error) {
	ip, _, _ := net.SplitHostPort(c.Conn().RemoteAddr().String())
	_, tls := c.TLSConnectionState()
	return &session{deps: b.Deps, ip: ip, helo: c.Hostname(), tls: tls}, nil
}

// ponytail: no limit per sending IP yet; rspamd's ratelimit module or a counter here when spam waves come.
type session struct {
	deps     Deps
	ip, helo string
	tls      bool
	from     string
	to       []string
	accounts []string
}

func (s *session) Reset()        { s.from, s.to, s.accounts = "", nil, nil }
func (s *session) Logout() error { return nil }

func (s *session) Mail(from string, _ *smtp.MailOptions) error {
	s.from = from
	return nil
}

func (s *session) Rcpt(to string, _ *smtp.RcptOptions) error {
	acc, err := s.deps.Lookup(context.Background(), Address(to))
	if err != nil {
		slog.Error("mx lookup", "err", err)
		return &smtp.SMTPError{Code: 451, EnhancedCode: smtp.EnhancedCode{4, 3, 0}, Message: "Try again later"}
	}
	if acc == "" {
		return &smtp.SMTPError{Code: 550, EnhancedCode: smtp.EnhancedCode{5, 1, 1}, Message: "No such mailbox here"}
	}
	s.to = append(s.to, to)
	// Two addresses of one mailbox get one copy.
	if !slices.Contains(s.accounts, acc) {
		s.accounts = append(s.accounts, acc)
	}
	return nil
}

func (s *session) Data(r io.Reader) error {
	ctx := context.Background()
	raw, err := io.ReadAll(r)
	if err != nil {
		return err
	}
	spam := false
	// Only our own say what passed: a sender's are dropped, with or without a filter.
	raw = strip(raw, []string{"Authentication-Results"})
	if s.deps.Check != nil {
		v, err := s.deps.Check(ctx, raw, Envelope{IP: s.ip, Helo: s.helo, From: s.from, To: s.to})
		if err != nil {
			slog.Error("mx filter", "err", err)
			return &smtp.SMTPError{Code: 451, EnhancedCode: smtp.EnhancedCode{4, 7, 1}, Message: "Try again later"}
		}
		switch v.Action {
		case "reject":
			return &smtp.SMTPError{Code: 550, EnhancedCode: smtp.EnhancedCode{5, 7, 1}, Message: "Message refused as spam"}
		case "soft reject", "greylist":
			return &smtp.SMTPError{Code: 451, EnhancedCode: smtp.EnhancedCode{4, 7, 1}, Message: "Try again later"}
		case "add header", "rewrite subject":
			spam = true
		}
		raw = append([]byte(strings.Join(v.Headers, "")), strip(raw, v.Remove)...)
	}
	raw = append([]byte(s.received()), raw...)

	id := rand.Text()
	for _, acc := range s.accounts {
		key := "in/" + id + "/" + acc
		err := s.deps.Spool(ctx, key, secret.Seal(s.deps.Master, raw))
		if err == nil {
			err = s.deps.Deliver(ctx, msg.MailDeliver{AccountId: acc, SpoolKey: key, Spam: spam}, id+"/"+acc)
		}
		if err != nil {
			// ponytail: a mailbox that got its copy before this failed gets it again on the retry, and the engine's
			// Message-ID check keeps it once; mail without a Message-ID shows twice.
			slog.Error("mx deliver", "account", acc, "err", err)
			return &smtp.SMTPError{Code: 451, EnhancedCode: smtp.EnhancedCode{4, 3, 0}, Message: "Try again later"}
		}
	}
	return nil
}

// received is the trace header every server adds in front of what it passes on (RFC 5321 4.4).
func (s *session) received() string {
	with := "ESMTP"
	if s.tls {
		with = "ESMTPS"
	}
	return fmt.Sprintf("Received: from %s ([%s])\r\n\tby %s with %s; %s\r\n",
		strings.ReplaceAll(s.helo, "\r\n", ""), s.ip, s.deps.Hostname, with, time.Now().UTC().Format(time.RFC1123Z))
}

// strip drops the header fields with these names, continuation lines included, and leaves the body as it is.
func strip(raw []byte, names []string) []byte {
	if len(names) == 0 {
		return raw
	}
	end := bytes.Index(raw, []byte("\r\n\r\n"))
	if end < 0 {
		return raw
	}
	var out []byte
	dropping := false
	for _, line := range bytes.SplitAfter(raw[:end+2], []byte("\r\n")) {
		if len(line) > 0 && line[0] != ' ' && line[0] != '\t' {
			name, _, _ := bytes.Cut(line, []byte(":"))
			dropping = slices.ContainsFunc(names, func(n string) bool { return strings.EqualFold(n, string(bytes.TrimSpace(name))) })
		}
		if !dropping {
			out = append(out, line...)
		}
	}
	return append(out, raw[end+2:]...)
}

// Address is how a recipient is looked up: lowercase, without a +tag, so lena+shop@ reaches lena@.
func Address(to string) string {
	to = strings.ToLower(strings.TrimSpace(to))
	at := strings.LastIndexByte(to, '@')
	if at < 0 {
		return to
	}
	local, domain := to[:at], to[at:]
	if plus := strings.IndexByte(local, '+'); plus > 0 {
		local = local[:plus]
	}
	return local + domain
}
