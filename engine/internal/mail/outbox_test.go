// SPDX-License-Identifier: AGPL-3.0-only

package mail

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	mathrand "math/rand/v2"
	"net"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-sasl"
	"github.com/emersion/go-smtp"

	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/db"
	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/msg"
	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/secret"
)

// smtpServer takes mail for the fixture's account and keeps it; fail decides, per message, what DATA answers.
type smtpServer struct {
	mu       sync.Mutex
	got      []string
	password string
	fail     func() error
}

func (b *smtpServer) NewSession(*smtp.Conn) (smtp.Session, error) { return &smtpSession{b: b}, nil }

type smtpSession struct{ b *smtpServer }

func (s *smtpSession) AuthMechanisms() []string { return []string{sasl.Plain} }
func (s *smtpSession) Auth(string) (sasl.Server, error) {
	return sasl.NewPlainServer(func(_, _, password string) error {
		s.b.mu.Lock()
		defer s.b.mu.Unlock()
		if password != s.b.password {
			return &smtp.SMTPError{Code: 535, EnhancedCode: smtp.EnhancedCode{5, 7, 8}, Message: "Wrong password"}
		}
		return nil
	}), nil
}
func (s *smtpSession) Mail(string, *smtp.MailOptions) error { return nil }
func (s *smtpSession) Rcpt(string, *smtp.RcptOptions) error { return nil }
func (s *smtpSession) Data(r io.Reader) error {
	raw, err := io.ReadAll(r)
	if err != nil {
		return err
	}
	s.b.mu.Lock()
	defer s.b.mu.Unlock()
	if s.b.fail != nil {
		if err := s.b.fail(); err != nil {
			return err
		}
	}
	s.b.got = append(s.b.got, string(raw))
	return nil
}
func (s *smtpSession) Reset()        {}
func (s *smtpSession) Logout() error { return nil }

// received is how many times a message with this Message-ID came in.
func (b *smtpServer) received(id string) int {
	b.mu.Lock()
	defer b.mu.Unlock()
	n := 0
	for _, m := range b.got {
		if strings.Contains(m, "Message-Id: <"+id+">") {
			n++
		}
	}
	return n
}

func (b *smtpServer) setFail(f func() error) {
	b.mu.Lock()
	b.fail = f
	b.mu.Unlock()
}

// sender is the fixture's account with an SMTP server of its own and a bucket in memory.
type sender struct {
	fixture
	smtp  *smtpServer
	q     *db.Queries
	files Files
	store map[string][]byte
}

func newSender(t *testing.T) *sender {
	f := setup(t)
	b := &smtpServer{password: "hunter2"}
	srv := smtp.NewServer(b)
	srv.Domain = "localhost"
	srv.TLSConfig = selfSigned(t)
	srv.AllowInsecureAuth = true
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })
	if _, err := f.pool.Exec(context.Background(), `UPDATE mail_account SET smtp_port = $2 WHERE id = $1`, f.id, ln.Addr().(*net.TCPAddr).Port); err != nil {
		t.Fatal(err)
	}
	s := &sender{fixture: f, smtp: b, q: db.New(f.pool), store: map[string][]byte{}}
	var mu sync.Mutex
	s.files = Files{
		Get: func(_ context.Context, key string) ([]byte, error) {
			mu.Lock()
			defer mu.Unlock()
			if d, ok := s.store[key]; ok {
				return d, nil
			}
			return nil, errors.New("no such key " + key)
		},
		Put: func(_ context.Context, key string, data []byte, _ string) error {
			mu.Lock()
			defer mu.Unlock()
			s.store[key] = data
			return nil
		},
		Remove: func(_ context.Context, key string) error {
			mu.Lock()
			defer mu.Unlock()
			delete(s.store, key)
			return nil
		},
	}
	return s
}

var testMaster = bytes.Repeat([]byte{7}, 32)

func (s *sender) cmd(subject string) msg.MessageSend {
	return msg.MessageSend{AccountId: s.id, DraftId: s.id + "-" + strings.ReplaceAll(subject, " ", "-"), To: []string{"max@x.example"},
		Cc: []string{}, Bcc: []string{"boss@x.example"}, Subject: subject, Text: "Hi"}
}

func (s *sender) deliver(t *testing.T, cmd msg.MessageSend, tries int) Outcome {
	t.Helper()
	out, err := Deliver(context.Background(), s.q, s.files, testMaster, cmd, tries)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func (s *sender) state(t *testing.T, draft string) string {
	t.Helper()
	st, err := s.q.SendState(context.Background(), draft)
	if err != nil {
		t.Fatal(err)
	}
	return st
}

// drafts is the subjects in the IMAP server's Drafts folder.
func (s *sender) drafts(t *testing.T) []string {
	t.Helper()
	acc, _ := s.q.GetAccount(context.Background(), s.id)
	c, err := DialIMAP(acc.ImapHost, int(acc.ImapPort), "lena", "hunter2", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = c.Logout().Wait() }()
	if sel, err := c.Select("Drafts", nil).Wait(); err != nil || sel.NumMessages == 0 {
		return nil
	}
	var all imap.SeqSet
	all.AddRange(1, 0)
	msgs, _ := c.Fetch(all, &imap.FetchOptions{Envelope: true}).Collect()
	var out []string
	for _, m := range msgs {
		out = append(out, m.Envelope.Subject)
	}
	return out
}

func TestDeliver(t *testing.T) {
	s := newSender(t)
	from := "lena@example.com"

	// Sent once, however often the command comes.
	plan := s.cmd("Plan")
	if out := s.deliver(t, plan, 1); out.Retry != 0 || out.Event.Error != nil || out.Event.DraftId != plan.DraftId {
		t.Fatalf("%+v", out)
	}
	s.deliver(t, plan, 2)
	s.deliver(t, plan, 1)
	if n := s.smtp.received(SendID(plan.DraftId, from)); n != 1 {
		t.Fatalf("received %d times", n)
	}
	if st := s.state(t, plan.DraftId); st != "sent" {
		t.Fatalf("state %s", st)
	}
	if strings.Contains(s.smtp.got[0], "boss@x.example") {
		t.Fatal("the Bcc went out in the headers")
	}

	// The server is busy: tried again later, and once it works it's sent.
	busy := s.cmd("Busy")
	s.smtp.setFail(func() error { return &smtp.SMTPError{Code: 451, Message: "Try later"} })
	if out := s.deliver(t, busy, 1); out.Retry != time.Minute {
		t.Fatalf("%+v", out)
	}
	s.smtp.setFail(nil)
	if out := s.deliver(t, busy, 2); out.Retry != 0 || out.Event.Error != nil {
		t.Fatalf("%+v", out)
	}
	if n := s.smtp.received(SendID(busy.DraftId, from)); n != 1 {
		t.Fatalf("received %d times", n)
	}

	// Busy until the last try: back in Drafts, and the event says why.
	late := s.cmd("Late")
	s.smtp.setFail(func() error { return &smtp.SMTPError{Code: 451, Message: "Try later"} })
	out := s.deliver(t, late, len(Retries)+1)
	if out.Retry != 0 || out.Event.Error == nil || s.state(t, late.DraftId) != "failed" {
		t.Fatalf("%+v %s", out, s.state(t, late.DraftId))
	}
	if d := s.drafts(t); len(d) != 1 || d[0] != "Late" {
		t.Fatalf("drafts %v", d)
	}

	// A refused recipient doesn't get better: given up at once.
	refused := s.cmd("Refused")
	s.smtp.setFail(func() error { return &smtp.SMTPError{Code: 550, Message: "No such user"} })
	if out := s.deliver(t, refused, 1); out.Retry != 0 || out.Event.Error == nil || !strings.Contains(*out.Event.Error, "No such user") {
		t.Fatalf("%+v", out)
	}
	s.smtp.setFail(nil)

	// Trying a failed one again from Drafts works.
	if out := s.deliver(t, refused, 1); out.Event.Error != nil || s.smtp.received(SendID(refused.DraftId, from)) != 1 {
		t.Fatalf("%+v", out)
	}

	// A wrong password shows on the account.
	s.smtp.mu.Lock()
	s.smtp.password = "changed"
	s.smtp.mu.Unlock()
	login := s.cmd("Login")
	if out := s.deliver(t, login, 1); out.Event.Error == nil || !strings.Contains(*out.Event.Error, "password") {
		t.Fatalf("%+v", out)
	}
	if acc, _ := s.q.GetAccount(context.Background(), s.id); !acc.SyncError.Valid {
		t.Fatal("no error on the account")
	}
}

func TestDeliverLater(t *testing.T) {
	s := newSender(t)
	ctx := context.Background()
	later := s.cmd("Later")
	at := time.Now().Add(48 * time.Hour)
	later.SendAt = &at
	later.Attachments = []msg.MessageSendAttachmentsElem{{Id: "f1", Name: "Plan.pdf", Type: "application/pdf"}}
	_ = s.files.Put(ctx, "upload/"+s.id+"/f1", []byte("%PDF-1"), "application/pdf")
	if out := s.deliver(t, later, 1); out.Event.Scheduled == nil || !*out.Event.Scheduled {
		t.Fatalf("%+v", out)
	}
	if st := s.state(t, later.DraftId); st != "scheduled" {
		t.Fatalf("state %s", st)
	}
	// The upload sweep can't take the file anymore.
	if _, ok := s.store["upload/"+s.id+"/f1"]; ok {
		t.Fatal("file still in upload/")
	}
	if _, ok := s.store["outbox/"+later.DraftId+"/f1"]; !ok {
		t.Fatal("file not kept in outbox/")
	}
	if due, _ := s.q.TakeDueSends(ctx); len(due) != 0 {
		t.Fatalf("%d due two days early", len(due))
	}
	if _, err := s.pool.Exec(ctx, `UPDATE outbox SET run_at = now() - interval '1 minute' WHERE draft_id = $1`, later.DraftId); err != nil {
		t.Fatal(err)
	}
	due, err := s.q.TakeDueSends(ctx)
	if err != nil || len(due) != 1 {
		t.Fatalf("%d due, %v", len(due), err)
	}
	plain, err := secret.Open(testMaster, due[0].Payload)
	if err != nil {
		t.Fatal(err)
	}
	var cmd msg.MessageSend
	if err := json.Unmarshal([]byte(plain), &cmd); err != nil || cmd.SendAt != nil {
		t.Fatalf("%+v %v", cmd, err)
	}
	if out := s.deliver(t, cmd, 1); out.Event.Error != nil {
		t.Fatalf("%+v", out)
	}
	if n := s.smtp.received(SendID(later.DraftId, "lena@example.com")); n != 1 || !strings.Contains(s.smtp.got[0], "Plan.pdf") {
		t.Fatalf("received %d", n)
	}
	if len(s.store) != 0 {
		t.Fatalf("left in the bucket: %v", s.store)
	}
}

// TestDeliverConverges sends drafts while commands come twice or three times and the server fails at random, the way
// restarts, redeliveries and flaky servers mix. Each draft goes out once at most, and one that didn't go is back in
// Drafts. SEED=n replays a run.
func TestDeliverConverges(t *testing.T) {
	s := newSender(t)
	seed, _ := strconv.ParseUint(os.Getenv("SEED"), 10, 64)
	if seed == 0 {
		seed = uint64(time.Now().UnixNano())
	}
	t.Log("SEED", seed)
	r := mathrand.New(mathrand.NewPCG(seed, seed))
	// The server's own, used only under its lock.
	rs := mathrand.New(mathrand.NewPCG(seed, seed+1))
	s.smtp.setFail(func() error {
		switch rs.IntN(6) {
		case 0:
			return &smtp.SMTPError{Code: 451, Message: "Try later"}
		case 1:
			return &smtp.SMTPError{Code: 550, Message: "No"}
		}
		return nil
	})
	sent, failed := 0, 0
	for i := range 20 {
		cmd := s.cmd(fmt.Sprint("Draft ", i))
		// One command and its copies, each brought back while it says to retry.
		for range 1 + r.IntN(3) {
			for tries := 1; ; tries++ {
				if out := s.deliver(t, cmd, tries); out.Retry == 0 {
					break
				}
			}
		}
		n := s.smtp.received(SendID(cmd.DraftId, "lena@example.com"))
		switch st := s.state(t, cmd.DraftId); {
		case n > 1:
			t.Fatalf("%s went out %d times", cmd.Subject, n)
		case st == "sent" && n == 1:
			sent++
		case st == "failed" && n == 0:
			failed++
		default:
			t.Fatalf("%s: state %s, received %d", cmd.Subject, st, n)
		}
	}
	if d := s.drafts(t); len(d) != failed {
		t.Fatalf("%d failed, %d in Drafts: %v", failed, len(d), d)
	}
	t.Log(sent, "sent", failed, "back in Drafts")
}

// A command for an account removed meanwhile is done with, not tried again.
func TestDeliverGoneAccount(t *testing.T) {
	s := newSender(t)
	cmd := s.cmd("Orphan")
	cmd.AccountId = "gone"
	if out := s.deliver(t, cmd, 1); out.Retry != 0 || out.Event.Error == nil {
		t.Fatalf("%+v", out)
	}
}
