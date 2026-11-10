// SPDX-License-Identifier: AGPL-3.0-only

package mx

import (
	"bytes"
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/emersion/go-smtp"

	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/msg"
	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/secret"
)

// fake is a running MX with what it spooled and delivered.
type fake struct {
	addr      string
	mu        sync.Mutex
	spooled   map[string][]byte
	delivered []msg.MailDeliver
	verdict   Verdict
	filterErr error
	sendErr   error
}

var master = bytes.Repeat([]byte{7}, 32)

func start(t *testing.T) *fake {
	f := &fake{spooled: map[string][]byte{}, verdict: Verdict{Action: "no action", Headers: []string{"Authentication-Results: mx.test; dkim=pass\r\n"}}}
	deps := Deps{
		Hostname: "mx.test",
		Master:   master,
		Lookup: func(_ context.Context, address string) (string, error) {
			return map[string]string{"lena@hosted.test": "acc-lena", "team@hosted.test": "acc-lena"}[address], nil
		},
		Check: func(_ context.Context, _ []byte, _ Envelope) (Verdict, error) { return f.verdict, f.filterErr },
		Spool: func(_ context.Context, key string, sealed []byte) error {
			f.mu.Lock()
			defer f.mu.Unlock()
			f.spooled[key] = sealed
			return nil
		},
		Deliver: func(_ context.Context, d msg.MailDeliver, _ string) error {
			f.mu.Lock()
			defer f.mu.Unlock()
			if f.sendErr != nil {
				return f.sendErr
			}
			f.delivered = append(f.delivered, d)
			return nil
		},
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	s := Server(deps, ln.Addr().String())
	go func() { _ = s.Serve(ln) }()
	t.Cleanup(func() { _ = s.Close() })
	f.addr = ln.Addr().String()
	return f
}

const mail = "From: Max <max@friend.org>\r\nTo: lena@hosted.test\r\nSubject: Dinner\r\nMessage-ID: <d@friend.org>\r\n\r\nFriday?\r\n"

// send returns the SMTP code the server ended with, 250 when it took the message.
func (f *fake) send(t *testing.T, to ...string) int {
	t.Helper()
	// Without TLS, the way plenty of servers still send on port 25.
	err := func() error {
		c, err := smtp.Dial(f.addr)
		if err != nil {
			return err
		}
		defer func() { _ = c.Close() }()
		if err := c.Mail("max@friend.org", nil); err != nil {
			return err
		}
		for _, r := range to {
			if err := c.Rcpt(r, nil); err != nil {
				return err
			}
		}
		w, err := c.Data()
		if err != nil {
			return err
		}
		if _, err := w.Write([]byte(mail)); err != nil {
			return err
		}
		return w.Close()
	}()
	var se *smtp.SMTPError
	if errors.As(err, &se) {
		return se.Code
	}
	if err != nil {
		t.Fatal(err)
	}
	return 250
}

func TestReceive(t *testing.T) {
	f := start(t)
	if code := f.send(t, "nobody@hosted.test"); code != 550 {
		t.Fatalf("unknown mailbox: %d", code)
	}
	// A +tag and a second address of the same mailbox: one copy.
	if code := f.send(t, "Lena+shop@hosted.test", "team@hosted.test"); code != 250 {
		t.Fatalf("took it with %d", code)
	}
	if len(f.delivered) != 1 || f.delivered[0].AccountId != "acc-lena" || f.delivered[0].Spam {
		t.Fatalf("delivered %+v", f.delivered)
	}
	plain, err := secret.Open(master, f.spooled[f.delivered[0].SpoolKey])
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(plain, "Received: from ") || !strings.Contains(plain, "Authentication-Results: mx.test; dkim=pass\r\n") ||
		!strings.HasSuffix(plain, mail) {
		t.Fatalf("spooled %q", plain)
	}

	for action, want := range map[string]int{"reject": 550, "soft reject": 451, "greylist": 451} {
		f.verdict = Verdict{Action: action}
		if code := f.send(t, "lena@hosted.test"); code != want {
			t.Fatalf("%s: %d, want %d", action, code, want)
		}
	}
	f.verdict = Verdict{Action: "add header"}
	if code := f.send(t, "lena@hosted.test"); code != 250 || !f.delivered[len(f.delivered)-1].Spam {
		t.Fatalf("spam: %d %+v", code, f.delivered)
	}
	// Whatever fails on our side, the sender tries again later.
	f.filterErr = errors.New("rspamd down")
	if code := f.send(t, "lena@hosted.test"); code != 451 {
		t.Fatalf("filter down: %d", code)
	}
	f.filterErr, f.sendErr = nil, errors.New("nats down")
	if code := f.send(t, "lena@hosted.test"); code != 451 {
		t.Fatalf("nats down: %d", code)
	}
}

func TestRspamd(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/checkv2" || r.Header.Get("IP") != "203.0.113.5" || len(r.Header.Values("Rcpt")) != 2 || r.Header.Get("MTA-Name") != "mx.test" {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		_, _ = w.Write([]byte(`{"action":"add header","milter":{"add_headers":{
			"Authentication-Results":{"value":"mx.test;\n\tdkim=fail","order":0},
			"X-Spam":[{"value":"Yes","order":0}]},"remove_headers":{"Authentication-Results":0}}}`))
	}))
	defer srv.Close()
	v, err := Rspamd(srv.URL, "mx.test")(context.Background(), []byte(mail), Envelope{IP: "203.0.113.5", Helo: "friend.org", From: "max@friend.org", To: []string{"a@x", "b@x"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(v.Remove) != 1 || v.Remove[0] != "Authentication-Results" {
		t.Fatalf("remove %v", v.Remove)
	}
	if v.Action != "add header" || len(v.Headers) != 2 || v.Headers[0] != "Authentication-Results: mx.test;\r\n\tdkim=fail\r\n" || v.Headers[1] != "X-Spam: Yes\r\n" {
		t.Fatalf("%+v", v)
	}
}

func TestAddress(t *testing.T) {
	for in, want := range map[string]string{"Lena+Shop@Hosted.Test": "lena@hosted.test", "+x@a.b": "+x@a.b", "plain": "plain"} {
		if got := Address(in); got != want {
			t.Fatalf("%q: %q, want %q", in, got, want)
		}
	}
}

// A sender's own Authentication-Results go, folded lines included; the body stays even if it looks like a header.
func TestStrip(t *testing.T) {
	raw := "Authentication-Results: evil; dkim=pass\r\n\tdmarc=pass\r\nFrom: a@b.c\r\nauthentication-results: x\r\n\r\nAuthentication-Results: in the body\r\n"
	want := "From: a@b.c\r\n\r\nAuthentication-Results: in the body\r\n"
	if got := string(strip([]byte(raw), []string{"Authentication-Results"})); got != want {
		t.Fatalf("%q", got)
	}
}
