// SPDX-License-Identifier: AGPL-3.0-only

// Package mail talks to IMAP/SMTP servers and parses what comes back.
package mail

import (
	"bytes"
	"crypto/tls"
	"fmt"
	"io"
	"net"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapclient"
	"github.com/emersion/go-message/mail"
	"github.com/emersion/go-msgauth/dkim"
	"github.com/emersion/go-sasl"
	"github.com/emersion/go-smtp"

	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/db"
)

type Header struct {
	Subject string
	From    string
	Date    string
}

func Parse(r io.Reader) (*Header, error) {
	mr, err := mail.CreateReader(r)
	if err != nil {
		return nil, err
	}
	defer func() { _ = mr.Close() }()
	subject, _ := mr.Header.Subject()
	from, _ := mr.Header.AddressList("From")
	addrs := make([]string, len(from))
	for i, a := range from {
		addrs[i] = a.String()
	}
	return &Header{Subject: subject, From: strings.Join(addrs, ", "), Date: mr.Header.Get("Date")}, nil
}

// DKIMValid is true only if the message carries signatures and all of them verify.
func DKIMValid(raw []byte) bool {
	vs, err := dkim.Verify(bytes.NewReader(raw))
	if err != nil || len(vs) == 0 {
		return false
	}
	for _, v := range vs {
		if v.Err != nil {
			return false
		}
	}
	return true
}

// MAIL_INSECURE_TLS=1 accepts self-signed certificates, for local test servers only.
func tlsConfig(host string) *tls.Config {
	return &tls.Config{ServerName: host, InsecureSkipVerify: os.Getenv("MAIL_INSECURE_TLS") == "1"} //nolint:gosec // opt-in for local servers
}

// DialIMAP uses implicit TLS on 993 and STARTTLS elsewhere, never plain text. on may be nil.
func DialIMAP(host string, port int, user, pass string, on *imapclient.UnilateralDataHandler) (*imapclient.Client, error) {
	opts := &imapclient.Options{TLSConfig: tlsConfig(host), UnilateralDataHandler: on}
	addr := net.JoinHostPort(host, strconv.Itoa(port))
	dial := imapclient.DialStartTLS
	if port == 993 {
		dial = imapclient.DialTLS
	}
	c, err := dial(addr, opts)
	if err != nil {
		return nil, err
	}
	if err := c.Login(user, pass).Wait(); err != nil {
		_ = c.Close()
		return nil, err
	}
	return c, nil
}

// kept holds one logged-in IMAP connection per account between commands, so the sync after new mail or a click
// doesn't pay for TCP, TLS and LOGIN again.
// ponytail: one per account, closed after 25 idle minutes: servers may drop idle connections after 30.
var kept = struct {
	sync.Mutex
	m map[string]keptConn
}{m: map[string]keptConn{}}

type keptConn struct {
	c     *imapclient.Client
	login string
	timer *time.Timer
	at    time.Time
}

// connect returns the account's kept connection if it is still logged in with the same settings, or a new one.
// Give it back with release. A connection kept for more than a minute may have been dropped by the server meanwhile:
// it is checked with a NOOP first, unless the caller retries on a new connection itself, like Sync.
func connect(acc db.MailAccount, pass string, check bool) (*imapclient.Client, error) {
	login := fmt.Sprint(acc.ImapHost, acc.ImapPort, acc.Username, string(acc.Secret))
	kept.Lock()
	k, ok := kept.m[acc.ID]
	delete(kept.m, acc.ID)
	kept.Unlock()
	if ok {
		k.timer.Stop()
		// The UNSELECT may still be on its way; the server runs what follows after it.
		st := k.c.State()
		if k.login == login && (st == imap.ConnStateAuthenticated || st == imap.ConnStateSelected) &&
			(!check || time.Since(k.at) < time.Minute || k.c.Noop().Wait() == nil) {
			return k.c, nil
		}
		_ = k.c.Close()
	}
	return DialIMAP(acc.ImapHost, int(acc.ImapPort), acc.Username, pass, nil)
}

// release keeps c for the account's next command, or closes it after an error: it may be stuck in the middle of one.
func release(acc db.MailAccount, c *imapclient.Client, err error) {
	if err != nil {
		_ = c.Close()
		return
	}
	k := keptConn{c: c, login: fmt.Sprint(acc.ImapHost, acc.ImapPort, acc.Username, string(acc.Secret)), at: time.Now()}
	if c.State() == imap.ConnStateSelected {
		// Servers answer STATUS for the selected folder with what the session has seen, so the next sync would miss
		// new mail there. Not waited for: it fails only with the connection, and then so does the next command.
		if !c.Caps().Has(imap.CapUnselect) && !c.Caps().Has(imap.CapIMAP4rev2) {
			_ = c.Close()
			return
		}
		_ = c.Unselect()
	}
	k.timer = time.AfterFunc(25*time.Minute, func() {
		kept.Lock()
		// Taken meanwhile: it's in use now.
		if kept.m[acc.ID].c != c {
			kept.Unlock()
			return
		}
		delete(kept.m, acc.ID)
		kept.Unlock()
		_ = c.Logout().Wait()
	})
	kept.Lock()
	old, ok := kept.m[acc.ID]
	kept.m[acc.ID] = k
	kept.Unlock()
	if ok {
		old.timer.Stop()
		_ = old.c.Close()
	}
}

// DialSMTP uses implicit TLS on 465 and STARTTLS elsewhere, never plain text, and logs in if the server asks for it.
func DialSMTP(host string, port int, user, pass string) (*smtp.Client, error) {
	addr := net.JoinHostPort(host, strconv.Itoa(port))
	dial := smtp.DialStartTLS
	if port == 465 {
		dial = smtp.DialTLS
	}
	c, err := dial(addr, tlsConfig(host))
	if err != nil {
		return nil, err
	}
	if ok, _ := c.Extension("AUTH"); ok {
		if err := c.Auth(sasl.NewPlainClient("", user, pass)); err != nil {
			_ = c.Close()
			return nil, err
		}
	}
	return c, nil
}
