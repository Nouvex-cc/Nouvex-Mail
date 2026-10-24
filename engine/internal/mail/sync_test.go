// SPDX-License-Identifier: AGPL-3.0-only

package mail

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hpke"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math/big"
	"net"
	"os"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapserver"
	"github.com/emersion/go-imap/v2/imapserver/imapmemserver"
	"github.com/emersion/go-message/mail"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/db"
	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/msg"
	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/seal"
)

// "hunter2" sealed with a master key of 32 bytes of 7, same vector as in the secret package.
const sealed = "AeVCfofwDm5ahJCtI82tdCIIVvFGf4BwyDIroAsv8BzQ4CPCXPqq675SlWplhAG7PyMZWGLwU3IYPM2t518oWtrlmqUm0PUvih+KsT87w8xD94X40wD1NabVp54hDhIi"

// fixture is an IMAP server with one user and a mail_account row pointing at it, and the user's key pair.
type fixture struct {
	pool   *pgxpool.Pool
	id     string
	add    func(subject string)
	addRaw func(raw string)
	key    *ecdh.PrivateKey
	// cut closes every open connection, like a server ending an idle one.
	cut func()
	// appendTo puts a message into a folder, made if it isn't there.
	appendTo func(box, raw string)
}

var noDrop = func(context.Context, string) error { return nil }

// opened is a stored message with its Meta opened again, the way a client does.
type opened struct {
	ID, Role, ThreadID string
	Meta
}

func (f fixture) messages(t *testing.T) []opened {
	t.Helper()
	rows, err := f.pool.Query(context.Background(), `SELECT m.id, b.role, m.thread_id, m.key, m.sealed FROM message m
		JOIN mailbox b ON b.id = m.mailbox_id WHERE m.account_id = $1 ORDER BY m.uid`, f.id)
	if err != nil {
		t.Fatal(err)
	}
	var out []opened
	for rows.Next() {
		var o opened
		var wrapped, sealed []byte
		if err := rows.Scan(&o.ID, &o.Role, &o.ThreadID, &wrapped, &sealed); err != nil {
			t.Fatal(err)
		}
		plain, err := open(unwrap(t, f.key, wrapped), "meta", sealed)
		if err != nil {
			t.Fatal(err)
		}
		_ = json.Unmarshal(plain, &o.Meta)
		out = append(out, o)
	}
	return out
}

// find is the first stored message with the subject, or an empty one.
func (f fixture) find(t *testing.T, subject string) opened {
	for _, m := range f.messages(t) {
		if m.Subject == subject {
			return m
		}
	}
	return opened{}
}

func unwrap(t *testing.T, private *ecdh.PrivateKey, wrapped []byte) []byte {
	k, _ := hpke.NewDHKEMPrivateKey(private)
	key, err := hpke.Open(k, hpke.HKDFSHA256(), hpke.AES256GCM(), []byte(seal.Info), wrapped)
	if err != nil {
		t.Fatal(err)
	}
	return key
}

func open(key []byte, label string, sealed []byte) ([]byte, error) {
	block, _ := aes.NewCipher(key)
	gcm, _ := cipher.NewGCM(block)
	return gcm.Open(nil, sealed[:gcm.NonceSize()], sealed[gcm.NonceSize():], []byte(label))
}

// Needs a migrated database (docker compose up -d postgres && bun run db:migrate).
func setup(t *testing.T) fixture {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		t.Skip("DATABASE_URL not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	mem := imapmemserver.New()
	u := imapmemserver.NewUser("lena", "hunter2")
	mem.AddUser(u)
	for _, box := range []string{"INBOX", "Trash"} {
		if err := u.Create(box, nil); err != nil {
			t.Fatal(err)
		}
	}
	addRaw := func(raw string) {
		if _, err := u.Append("INBOX", bytes.NewReader([]byte(raw)), &imap.AppendOptions{}); err != nil {
			t.Error(err)
		}
	}
	appendTo := func(box, raw string) {
		_ = u.Create(box, nil)
		if _, err := u.Append(box, bytes.NewReader([]byte(raw)), &imap.AppendOptions{}); err != nil {
			t.Error(err)
		}
	}
	add := func(subject string) {
		raw := fmt.Sprintf("From: Lena Hartmann <lena@example.com>\r\nSubject: %s\r\nDate: Thu, 8 Oct 2026 09:12:00 +0200\r\nMessage-ID: <%s@example.com>\r\n\r\nHi", subject, rand.Text())
		if _, err := u.Append("INBOX", bytes.NewReader([]byte(raw)), &imap.AppendOptions{}); err != nil {
			t.Error(err)
		}
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var conns []net.Conn
	cut := func() {
		mu.Lock()
		defer mu.Unlock()
		for _, c := range conns {
			_ = c.Close()
		}
	}
	srv := imapserver.New(&imapserver.Options{
		NewSession: func(c *imapserver.Conn) (imapserver.Session, *imapserver.GreetingData, error) {
			mu.Lock()
			conns = append(conns, c.NetConn())
			mu.Unlock()
			return mem.NewSession(), nil, nil
		},
		Caps:      imap.CapSet{imap.CapIMAP4rev1: {}, imap.CapIdle: {}},
		TLSConfig: selfSigned(t),
	})
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })
	t.Setenv("MAIL_INSECURE_TLS", "1")

	id := rand.Text()
	secret, _ := base64.StdEncoding.DecodeString(sealed)
	port := ln.Addr().(*net.TCPAddr).Port
	if _, err := pool.Exec(ctx, `INSERT INTO "user" (id, name, email, created_at, updated_at) VALUES ($1, 'Lena', $1 || '@test', now(), now())`, id); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM change_log WHERE account_id = $1`, id)
		_, _ = pool.Exec(context.Background(), `DELETE FROM "user" WHERE id = $1`, id)
	})
	if _, err := pool.Exec(ctx, `INSERT INTO mail_account (id, user_id, email, imap_host, imap_port, smtp_host, smtp_port, username, secret)
		VALUES ($1, $1, 'lena@example.com', '127.0.0.1', $2, '127.0.0.1', 25, 'lena', $3)`, id, port, secret); err != nil {
		t.Fatal(err)
	}
	key, _ := ecdh.X25519().GenerateKey(rand.Reader)
	if _, err := pool.Exec(ctx, `INSERT INTO user_key (user_id, public_key, wrapped_private) VALUES ($1, $2, '')`, id, key.PublicKey().Bytes()); err != nil {
		t.Fatal(err)
	}
	return fixture{pool, id, add, addRaw, key, cut, appendTo}
}

func TestSync(t *testing.T) {
	f := setup(t)
	ctx, pool, id, add := context.Background(), f.pool, f.id, f.add
	add("Keys for the new flat")
	add("Saturday")

	master := bytes.Repeat([]byte{7}, 32)
	stored := map[string][]byte{}
	var mu sync.Mutex
	put := func(_ context.Context, key string, data []byte, _ string) error {
		mu.Lock()
		defer mu.Unlock()
		stored[key] = data
		return nil
	}
	// INBOX and Trash, then the two messages.
	for _, want := range []int64{4, 4} {
		if v, err := Sync(ctx, pool, Store{Put: put, Drop: noDrop}, master, id, func(int64) {}); err != nil || v != want {
			t.Fatalf("version %d, %v; want %d", v, err, want)
		}
	}
	add("Invoice")
	if v, err := Sync(ctx, pool, Store{Put: put, Drop: noDrop}, master, id, func(int64) {}); err != nil || v != 5 {
		t.Fatalf("version %d, %v; want 5", v, err)
	}
	var roles []string
	_ = pool.QueryRow(ctx, `SELECT array_agg(name || ':' || role ORDER BY name) FROM mailbox WHERE account_id = $1`, id).Scan(&roles)
	if !slices.Equal(roles, []string{"INBOX:inbox", "Trash:trash"}) {
		t.Fatalf("roles %v", roles)
	}
	first := f.messages(t)[0]
	if first.FromAddr != "lena@example.com" || first.Subject != "Keys for the new flat" || first.Snippet != "Hi" {
		t.Fatalf("got %+v", first.Meta)
	}
	// Nothing readable is stored: the body only opens with the message's key.
	var wrapped []byte
	_ = pool.QueryRow(ctx, `SELECT key FROM message WHERE id = $1`, first.ID).Scan(&wrapped)
	body, err := open(unwrap(t, f.key, wrapped), "body", stored["body/"+first.ID+".html"])
	if len(stored) != 3 || err != nil || !bytes.Contains(body, []byte(">Hi</div>")) {
		t.Fatalf("stored %d objects, %q %v", len(stored), body, err)
	}
	for k, v := range stored {
		if bytes.Contains(v, []byte("Hi")) {
			t.Fatalf("%s readable", k)
		}
	}
}

// Without a key nothing is fetched; a new key (after a reset) drops what was sealed to the old one.
func TestKeyChange(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	put := func(context.Context, string, []byte, string) error { return nil }
	var dropped []string
	store := Store{Put: put, Drop: func(_ context.Context, id string) error { dropped = append(dropped, id); return nil }}
	master := bytes.Repeat([]byte{7}, 32)
	f.add("Before the reset")
	if _, err := Sync(ctx, f.pool, store, master, f.id, func(int64) {}); err != nil {
		t.Fatal(err)
	}
	_, _ = f.pool.Exec(ctx, `DELETE FROM user_key WHERE user_id = $1`, f.id)
	if _, err := Sync(ctx, f.pool, store, master, f.id, func(int64) {}); err != nil {
		t.Fatal(err)
	}
	if len(f.messages(t)) != 0 || len(dropped) != 1 {
		t.Fatalf("%d messages left, %d dropped", len(f.messages(t)), len(dropped))
	}
	f.key, _ = ecdh.X25519().GenerateKey(rand.Reader)
	_, _ = f.pool.Exec(ctx, `INSERT INTO user_key (user_id, public_key, wrapped_private) VALUES ($1, $2, '')`, f.id, f.key.PublicKey().Bytes())
	if _, err := Sync(ctx, f.pool, store, master, f.id, func(int64) {}); err != nil {
		t.Fatal(err)
	}
	if m := f.messages(t); len(m) != 1 || m[0].Subject != "Before the reset" {
		t.Fatalf("got %+v", m)
	}
}

func selfSigned(t *testing.T) *tls.Config {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(1), IPAddresses: []net.IP{net.IPv4(127, 0, 0, 1)}}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}}}
}

func TestUIDValidityChange(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	put := func(context.Context, string, []byte, string) error { return nil }
	master := bytes.Repeat([]byte{7}, 32)
	f.add("One")
	f.add("Two")
	if _, err := Sync(ctx, f.pool, Store{Put: put, Drop: noDrop}, master, f.id, func(int64) {}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(ctx, `UPDATE mailbox SET uid_validity = uid_validity + 1 WHERE account_id = $1`, f.id); err != nil {
		t.Fatal(err)
	}
	// Both folders were renumbered: both old rows are deleted, both messages come back as new rows, and both
	// folders are logged as changed.
	if v, err := Sync(ctx, f.pool, Store{Put: put, Drop: noDrop}, master, f.id, func(int64) {}); err != nil || v != 10 {
		t.Fatalf("version %d, %v; want 10", v, err)
	}
	var deletes, rows int
	_ = f.pool.QueryRow(ctx, `SELECT count(*) FROM change_log WHERE account_id = $1 AND op = 'delete'`, f.id).Scan(&deletes)
	_ = f.pool.QueryRow(ctx, `SELECT count(*) FROM message WHERE account_id = $1`, f.id).Scan(&rows)
	if deletes != 2 || rows != 2 {
		t.Fatalf("%d deletes, %d rows", deletes, rows)
	}
}

func TestUpdate(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	q := db.New(f.pool)
	put := func(context.Context, string, []byte, string) error { return nil }
	master := bytes.Repeat([]byte{7}, 32)
	f.add("Read me")
	f.add("Throw me away")
	if _, err := Sync(ctx, f.pool, Store{Put: put, Drop: noDrop}, master, f.id, func(int64) {}); err != nil {
		t.Fatal(err)
	}
	ids := map[string]string{}
	for _, m := range f.messages(t) {
		ids[m.Subject] = m.ID
	}
	yes := true
	if err := Update(ctx, q, master, msg.MessageUpdate{AccountId: f.id, MessageId: ids["Read me"], Seen: &yes, Flagged: &yes}); err != nil {
		t.Fatal(err)
	}
	if err := Update(ctx, q, master, msg.MessageUpdate{AccountId: f.id, MessageId: ids["Throw me away"], Trash: &yes}); err != nil {
		t.Fatal(err)
	}
	// One flag change, one message gone from the INBOX and the same one new in Trash.
	if v, err := Sync(ctx, f.pool, Store{Put: put, Drop: noDrop}, master, f.id, func(int64) {}); err != nil || v != 7 {
		t.Fatalf("version %d, %v; want 7", v, err)
	}
	f.add("Keep me")
	if _, err := Sync(ctx, f.pool, Store{Put: put, Drop: noDrop}, master, f.id, func(int64) {}); err != nil {
		t.Fatal(err)
	}
	keep := f.find(t, "Keep me").ID
	// No archive folder on the test server: it gets created.
	if err := Update(ctx, q, master, msg.MessageUpdate{AccountId: f.id, MessageId: keep, Archive: &yes}); err != nil {
		t.Fatal(err)
	}
	if _, err := Sync(ctx, f.pool, Store{Put: put, Drop: noDrop}, master, f.id, func(int64) {}); err != nil {
		t.Fatal(err)
	}
	if f.find(t, "Keep me").Role != "archive" {
		t.Fatal("archived message not in Archive")
	}
	if f.find(t, "Throw me away").Role != "trash" {
		t.Fatal("trashed message not in Trash")
	}
	var flags []string
	if err := f.pool.QueryRow(ctx, `SELECT flags FROM message WHERE id = $1`, ids["Read me"]).Scan(&flags); err != nil || !slices.Equal(flags, []string{`\Flagged`, `\Seen`}) {
		t.Fatalf("flags %v, %v", flags, err)
	}
	var left int
	_ = f.pool.QueryRow(ctx, `SELECT count(*) FROM message WHERE id = $1`, ids["Throw me away"]).Scan(&left)
	if left != 0 {
		t.Fatal("trashed message still in the INBOX")
	}
}

func TestWatch(t *testing.T) {
	f := setup(t)
	ctx, cancel := context.WithCancel(context.Background())
	calls := make(chan struct{}, 10)
	done := make(chan struct{})
	ups := 0
	go func() {
		Watch(ctx, db.New(f.pool), bytes.Repeat([]byte{7}, 32), f.id, func() { calls <- struct{}{} }, func(err error) {
			if err != nil {
				t.Error("reported a dropped connection:", err)
			}
			ups++
		})
		close(done)
	}()
	wait := func(what string) {
		select {
		case <-calls:
		case <-time.After(10 * time.Second):
			t.Fatal("no call " + what)
		}
	}
	wait("after connecting")
	f.add("Invoice")
	wait("for new mail")
	f.cut()
	wait("after reconnecting")
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Watch didn't return after cancel")
	}
	if ups != 2 {
		t.Errorf("heard %d working connections, want 2", ups)
	}
}

func TestWatchSkipsArchived(t *testing.T) {
	f := setup(t)
	if _, err := f.pool.Exec(context.Background(), `UPDATE mail_account SET archived_at = now() WHERE id = $1`, f.id); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() {
		Watch(context.Background(), db.New(f.pool), bytes.Repeat([]byte{7}, 32), f.id, func() { t.Error("synced an archived account") }, func(error) {})
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Watch kept running for an archived account")
	}
}

func TestSaveSent(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	raw, _ := Compose(mail.Address{Address: "lena@example.com"}, msg.MessageSend{To: []string{"a@x.example"}, Subject: "Hi", Text: "Hi"}, "", "", nil, time.Now())
	// The test server has no Sent folder, so it gets created.
	if err := SaveSent(ctx, db.New(f.pool), bytes.Repeat([]byte{7}, 32), f.id, raw); err != nil {
		t.Fatal(err)
	}
	acc, _ := db.New(f.pool).GetAccount(ctx, f.id)
	c, err := DialIMAP(acc.ImapHost, int(acc.ImapPort), "lena", "hunter2", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = c.Logout().Wait() }()
	if sel, err := c.Select("Sent", nil).Wait(); err != nil || sel.NumMessages != 1 {
		t.Fatalf("%+v %v", sel, err)
	}
}

func TestSyncInBatches(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	for i := range 60 {
		f.add(fmt.Sprint("Mail ", i))
	}
	var saves []int64
	put := func(context.Context, string, []byte, string) error { return nil }
	v, err := Sync(ctx, f.pool, Store{Put: put, Drop: noDrop}, bytes.Repeat([]byte{7}, 32), f.id, func(v int64) { saves = append(saves, v) })
	// INBOX: one save per batch of 50, then the folder; Trash: the folder.
	if err != nil || v != 62 || !slices.Contains(saves, 51) || !slices.Contains(saves, 61) {
		t.Fatalf("version %d, %v, saves %v", v, err, saves)
	}
}

func TestThreads(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	put := func(context.Context, string, []byte, string) error { return nil }
	master := bytes.Repeat([]byte{7}, 32)
	mail := func(id, subject, headers string) string {
		return "From: Lena <lena@example.com>\r\nSubject: " + subject + "\r\nMessage-ID: <" + id + ">\r\n" + headers + "\r\nHi"
	}
	sync := func() {
		if _, err := Sync(ctx, f.pool, Store{Put: put, Drop: noDrop}, master, f.id, func(int64) {}); err != nil {
			t.Fatal(err)
		}
	}
	threadOf := func(subject string) string { return f.find(t, subject).ThreadID }

	f.addRaw(mail("a@x", "Keys", ""))
	f.addRaw(mail("b@x", "Re: Keys", "In-Reply-To: <a@x>\r\nReferences: <a@x>\r\n"))
	f.addRaw(mail("c@x", "Saturday", ""))
	// Mail without a Message-ID doesn't belong together just for that.
	f.addRaw("From: a@x\r\nSubject: Ad 1\r\n\r\nHi")
	f.addRaw("From: a@x\r\nSubject: Ad 2\r\n\r\nHi")
	// An answer to a message we haven't seen yet starts a conversation of its own...
	f.addRaw(mail("e@x", "Re: Invoice", "In-Reply-To: <d@x>\r\n"))
	sync()
	if threadOf("Ad 1") == threadOf("Ad 2") {
		t.Fatal("mail without a Message-ID grouped together")
	}
	if threadOf("Keys") == "" || threadOf("Keys") != threadOf("Re: Keys") || threadOf("Keys") == threadOf("Saturday") {
		t.Fatal("answer not in the conversation it answers")
	}
	// ...and joins it once the message it answers arrives, together with what came before.
	f.addRaw(mail("d@x", "Invoice", "References: <c@x>\r\n"))
	sync()
	if threadOf("Invoice") != threadOf("Re: Invoice") || threadOf("Invoice") != threadOf("Saturday") {
		t.Fatalf("conversations not merged: %q %q %q", threadOf("Saturday"), threadOf("Invoice"), threadOf("Re: Invoice"))
	}
}

func TestSnooze(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	q := db.New(f.pool)
	put := func(context.Context, string, []byte, string) error { return nil }
	master := bytes.Repeat([]byte{7}, 32)
	sync := func() {
		if _, err := Sync(ctx, f.pool, Store{Put: put, Drop: noDrop}, master, f.id, func(int64) {}); err != nil {
			t.Fatal(err)
		}
	}
	roleOf := func() string { return f.find(t, "Later").Role }
	f.add("Later")
	sync()
	id := f.find(t, "Later").ID

	until := time.Now().Add(-time.Second)
	if err := Update(ctx, q, master, msg.MessageUpdate{AccountId: f.id, MessageId: id, SnoozeUntil: &until}); err != nil {
		t.Fatal(err)
	}
	sync()
	if roleOf() != "snoozed" {
		t.Fatalf("in %q, not snoozed", roleOf())
	}
	jobs, err := q.TakeDueJobs(ctx)
	var mine []db.Scheduled
	for _, j := range jobs {
		if j.AccountID == f.id {
			mine = append(mine, j)
		}
	}
	if err != nil || len(mine) != 1 || mine[0].Kind != "unsnooze" {
		t.Fatalf("%+v %v", mine, err)
	}
	var p struct{ MessageID string }
	_ = json.Unmarshal(mine[0].Payload, &p)
	back, err := q.FindByRole(ctx, db.FindByRoleParams{AccountID: f.id, MessageID: p.MessageID, Role: "snoozed"})
	if err != nil {
		t.Fatal(err)
	}
	yes := true
	if err := Update(ctx, q, master, msg.MessageUpdate{AccountId: f.id, MessageId: back, Inbox: &yes}); err != nil {
		t.Fatal(err)
	}
	sync()
	if roleOf() != "inbox" {
		t.Fatalf("in %q, not back in the INBOX", roleOf())
	}
}

func TestDrafts(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	q := db.New(f.pool)
	master := bytes.Repeat([]byte{7}, 32)
	save := func(text string, discard bool) {
		d := msg.DraftSave{AccountId: f.id, DraftId: "d1", To: []string{"a@x.example"}, Cc: []string{}, Bcc: []string{}, Subject: "Plan", Text: text}
		if discard {
			d.Discard = &discard
		}
		if err := SaveDraft(ctx, q, master, d); err != nil {
			t.Fatal(err)
		}
	}
	acc, _ := q.GetAccount(ctx, f.id)
	drafts := func() []string {
		c, err := DialIMAP(acc.ImapHost, int(acc.ImapPort), "lena", "hunter2", nil)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = c.Logout().Wait() }()
		sel, err := c.Select("Drafts", nil).Wait()
		if err != nil || sel.NumMessages == 0 {
			return nil
		}
		whole := &imap.FetchItemBodySection{}
		msgs, _ := c.Fetch(imap.SeqSetNum(1), &imap.FetchOptions{BodySection: []*imap.FetchItemBodySection{whole}}).Collect()
		var out []string
		for _, m := range msgs {
			p, _ := Content(m.FindBodySection(whole))
			out = append(out, p.Snippet)
		}
		if sel.NumMessages != uint32(len(out)) {
			t.Fatalf("%d drafts", sel.NumMessages)
		}
		return out
	}
	save("first", false)
	save("second", false)
	if got := drafts(); !slices.Equal(got, []string{"second"}) {
		t.Fatalf("drafts %v", got)
	}
	save("", true)
	if got := drafts(); len(got) != 0 {
		t.Fatalf("drafts %v after discard", got)
	}
}

// TestSyncCondstore runs the CONDSTORE path against a real server (IMAP_SERVER, see bench_test.go): after every
// sync, the database holds exactly the server's messages and flags.
func TestSyncCondstore(t *testing.T) {
	e := benchEnv(t)
	u := e.mailbox(t, map[string]int{"INBOX": 5, "Archive": 3})
	if !u.c.Caps().Has(imap.CapCondStore) {
		t.Skip("server without CONDSTORE")
	}
	id := e.account(t, u, e.imap)
	var version int64
	sync := func(what string, changes int64) {
		t.Helper()
		v, err := Sync(e.ctx, e.pool, Store{Put: e.put, Drop: noDrop}, e.master, id, func(int64) {})
		if err != nil {
			t.Fatal(what, err)
		}
		if changes >= 0 && v-version != changes {
			t.Errorf("%s: %d changes, want %d", what, v-version, changes)
		}
		version = v
		for _, folder := range []string{"INBOX", "Archive"} {
			if _, err := u.c.Select(folder, &imap.SelectOptions{ReadOnly: true}).Wait(); err != nil {
				t.Fatal(err)
			}
			var all imap.UIDSet
			all.AddRange(1, 0)
			msgs, err := u.c.Fetch(all, &imap.FetchOptions{UID: true, Flags: true}).Collect()
			if err != nil {
				t.Fatal(err)
			}
			var server, stored []string
			for _, m := range msgs {
				server = append(server, fmt.Sprint(m.UID, flagStrings(m.Flags)))
			}
			rows, _ := e.pool.Query(e.ctx, `SELECT m.uid, m.flags FROM message m JOIN mailbox b ON b.id = m.mailbox_id
				WHERE m.account_id = $1 AND b.name = $2 ORDER BY m.uid`, id, folder)
			for rows.Next() {
				var uid int64
				var flags []string
				_ = rows.Scan(&uid, &flags)
				stored = append(stored, fmt.Sprint(uid, flags))
			}
			if !slices.Equal(server, stored) {
				t.Fatalf("%s, %s:\nserver %v\nstored %v", what, folder, server, stored)
			}
		}
	}
	inbox := func() {
		if _, err := u.c.Select("INBOX", nil).Wait(); err != nil {
			t.Fatal(err)
		}
	}
	store := func(uid imap.UID, op imap.StoreFlagsOp, flag imap.Flag) {
		if err := u.c.Store(imap.UIDSetNum(uid), &imap.StoreFlags{Op: op, Silent: true, Flags: []imap.Flag{flag}}, nil).Close(); err != nil {
			t.Fatal(err)
		}
	}

	sync("first sync", -1)
	sync("nothing new", 0)
	u.append(t, "INBOX", reply("new-1", "INBOX-0"))
	u.append(t, "INBOX", newsletter("new-2"))
	sync("new mail", 2)
	inbox()
	store(1, imap.StoreFlagsAdd, imap.FlagSeen)
	store(2, imap.StoreFlagsAdd, imap.FlagFlagged)
	sync("flags", 2)
	inbox()
	store(1, imap.StoreFlagsDel, imap.FlagSeen)
	store(3, imap.StoreFlagsAdd, imap.FlagDeleted)
	if err := u.c.Expunge().Close(); err != nil {
		t.Fatal(err)
	}
	sync("flag and expunge", 2)
	inbox()
	if _, err := u.c.Move(imap.UIDSetNum(4), "Archive").Wait(); err != nil {
		t.Fatal(err)
	}
	sync("move", 2)
	// As many messages as before: only the UIDs tell that one is gone.
	inbox()
	store(5, imap.StoreFlagsAdd, imap.FlagDeleted)
	if err := u.c.Expunge().Close(); err != nil {
		t.Fatal(err)
	}
	u.append(t, "INBOX", reply("new-3", "new-1"))
	sync("expunge and new mail", 2)
	var msgID string
	_ = e.pool.QueryRow(e.ctx, `SELECT id FROM message WHERE account_id = $1 ORDER BY uid LIMIT 1`, id).Scan(&msgID)
	yes := true
	if err := Update(e.ctx, db.New(e.pool), e.master, msg.MessageUpdate{AccountId: id, MessageId: msgID, Seen: &yes}); err != nil {
		t.Fatal(err)
	}
	// Saved right away, the sync finds nothing left to do.
	var v int64
	_ = e.pool.QueryRow(e.ctx, `SELECT version FROM mail_account WHERE id = $1`, id).Scan(&v)
	if v != version+1 {
		t.Fatalf("marked read: version %d, want %d", v, version+1)
	}
	version = v
	sync("marked read", 0)
	// No flags left: still saved right away.
	no := false
	if err := Update(e.ctx, db.New(e.pool), e.master, msg.MessageUpdate{AccountId: id, MessageId: msgID, Seen: &no}); err != nil {
		t.Fatal(err)
	}
	_ = e.pool.QueryRow(e.ctx, `SELECT version FROM mail_account WHERE id = $1`, id).Scan(&v)
	if v != version+1 {
		t.Fatalf("marked unread: version %d, want %d", v, version+1)
	}
	version = v
	sync("marked unread", 0)
	// The kept connection broke meanwhile.
	kept.Lock()
	_ = kept.m[id].c.Close()
	kept.Unlock()
	u.append(t, "Archive", reply("new-4", "new-3"))
	sync("after a dropped connection", 1)
	sync("nothing new again", 0)
}

func TestGmailArchive(t *testing.T) {
	box := func(name string, attrs ...imap.MailboxAttr) *imap.ListData {
		return &imap.ListData{Mailbox: name, Attrs: attrs}
	}
	names := func(boxes []*imap.ListData) (s []string) {
		for _, b := range boxes {
			s = append(s, b.Mailbox+"="+role(b))
		}
		return s
	}
	gmail := names(skipVirtual([]*imap.ListData{box("INBOX"), box("[Gmail]/All Mail", imap.MailboxAttrAll), box("[Gmail]/Starred", imap.MailboxAttrFlagged)}))
	if want := []string{"INBOX=inbox", "[Gmail]/All Mail=archive"}; !slices.Equal(gmail, want) {
		t.Errorf("gmail: %v, want %v", gmail, want)
	}
	both := names(skipVirtual([]*imap.ListData{box("Archive", imap.MailboxAttrArchive), box("All", imap.MailboxAttrAll)}))
	if want := []string{"Archive=archive"}; !slices.Equal(both, want) {
		t.Errorf("with an archive: %v, want %v", both, want)
	}
}

// Seeded mail lands in the inbox in a local mailbox, once, stays through syncs and changes in the database alone.
func TestSeed(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	master := bytes.Repeat([]byte{7}, 32)
	store := Store{Put: func(context.Context, string, []byte, string) error { return nil }, Drop: noDrop}
	raw := []byte("From: Nouvex <hello@nouvex.cc>\r\nSubject: Groups\r\nMessage-ID: <groups@nouvex.cc>\r\nMIME-Version: 1.0\r\n" +
		"Content-Type: multipart/alternative; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nGroups\r\n" +
		"--b\r\nContent-Type: text/x-nouvex-html\r\n\r\n<nx-carousel></nx-carousel>\r\n--b\r\nContent-Type: text/html\r\n\r\n<p>Groups</p>\r\n--b--\r\n")
	// The second time it's there already and nothing changes.
	for _, want := range []string{f.id, ""} {
		if acc, _, err := Seed(ctx, f.pool, store, f.id, raw); err != nil || acc != want {
			t.Fatalf("%q %v, want %q", acc, err, want)
		}
	}
	if _, err := Sync(ctx, f.pool, store, master, f.id, func(int64) {}); err != nil {
		t.Fatal(err)
	}
	m := f.find(t, "Groups")
	if m.Role != "inbox" || !m.Seeded || !m.Rich || m.FromAddr != "hello@nouvex.cc" || len(f.messages(t)) != 1 {
		t.Fatalf("%+v of %d", m, len(f.messages(t)))
	}
	q := db.New(f.pool)
	yes := true
	if err := Update(ctx, q, master, msg.MessageUpdate{AccountId: f.id, MessageId: m.ID, Seen: &yes}); err != nil {
		t.Fatal(err)
	}
	var flags []string
	_ = f.pool.QueryRow(ctx, `SELECT flags FROM message WHERE id = $1`, m.ID).Scan(&flags)
	if !slices.Equal(flags, []string{`\Seen`}) {
		t.Fatalf("flags %v", flags)
	}
	if err := Update(ctx, q, master, msg.MessageUpdate{AccountId: f.id, MessageId: m.ID, Archive: &yes}); err != nil {
		t.Fatal(err)
	}
	if n := len(f.messages(t)); n != 0 {
		t.Fatalf("%d messages after archiving", n)
	}
}

// New mail is sorted by what the user said about its sender, then by whether they wrote to it, then by the message.
func TestSort(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	f.appendTo("Sent", "From: lena@example.com\r\nTo: Max <Max@friend.org>\r\nSubject: Dinner\r\nMessage-ID: <d@example.com>\r\n\r\nTomorrow?")
	// From someone Lena wrote to, even with a list's headers.
	f.addRaw("From: Max <max@friend.org>\r\nSubject: Club news\r\nList-Unsubscribe: <https://friend.org/u>\r\nMessage-ID: <c@friend.org>\r\n\r\nSee you at practice.")
	f.addRaw("From: Shop <news@mail.shop.example>\r\nSubject: New in\r\nList-Unsubscribe: <https://shop.example/u>, <mailto:u@shop.example>\r\n" +
		"List-Unsubscribe-Post: List-Unsubscribe=One-Click\r\nMessage-ID: <n@shop.example>\r\n\r\nOur autumn collection.")
	f.addRaw("From: Store <hi@store.example>\r\nSubject: Weekly\r\nList-Unsubscribe: <https://store.example/u>\r\nMessage-ID: <w@store.example>\r\n\r\nThis week.")
	f.addRaw("Authentication-Results: mx.example.com; dkim=none; spf=softfail\r\nFrom: \"PayPal\" <secure@account-verify-center.top>\r\nSubject: Your account has been limited\r\n" +
		"Message-ID: <p@top>\r\nContent-Type: text/html\r\n\r\n<p>Dear Customer, your account access has been limited until you verify your identity. " +
		`<a href="http://account-verify-center.top/login">www.paypal.com</a> Confirm your billing information within 24 hours or your account will be suspended.</p>`)
	// Lena moved the store's mail to Promotions before.
	if _, err := f.pool.Exec(ctx, `INSERT INTO sender_rule (user_id, sender, category) VALUES ($1, $2, 'promotions')`, f.id, Sender("@store.example")); err != nil {
		t.Fatal(err)
	}
	if _, err := Sync(ctx, f.pool, Store{Put: func(context.Context, string, []byte, string) error { return nil }, Drop: noDrop}, bytes.Repeat([]byte{7}, 32), f.id, func(int64) {}); err != nil {
		t.Fatal(err)
	}
	for subject, want := range map[string]string{
		"Club news": "primary false", "New in": "newsletters false", "Weekly": "promotions false",
		"Your account has been limited": "primary true",
	} {
		var got string
		_ = f.pool.QueryRow(ctx, `SELECT category || ' ' || spam FROM message WHERE id = $1`, f.find(t, subject).ID).Scan(&got)
		if got != want {
			t.Errorf("%s: %q, want %q", subject, got, want)
		}
	}
	// Contacts kept before this existed fill in once from the Sent folder.
	var n int
	_, _ = f.pool.Exec(ctx, `DELETE FROM contact WHERE user_id = $1`, f.id)
	if _, err := Sync(ctx, f.pool, Store{Put: func(context.Context, string, []byte, string) error { return nil }, Drop: noDrop}, bytes.Repeat([]byte{7}, 32), f.id, func(int64) {}); err != nil {
		t.Fatal(err)
	}
	_ = f.pool.QueryRow(ctx, `SELECT count(*) FROM contact WHERE user_id = $1 AND hash = $2`, f.id, Sender("max@friend.org")).Scan(&n)
	if n != 1 {
		t.Errorf("contact after backfill: %d", n)
	}
	if u := f.find(t, "New in").Unsubscribe; u == nil || u.URL != "https://shop.example/u" || u.Mailto != "mailto:u@shop.example" || !u.OneClick {
		t.Errorf("unsubscribe %+v", u)
	}
}

// Sorting by hand changes the tab in the database alone; spam moves to the junk folder and back.
func TestSortByHand(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	master := bytes.Repeat([]byte{7}, 32)
	store := Store{Put: func(context.Context, string, []byte, string) error { return nil }, Drop: noDrop}
	f.appendTo("Junk", "From: x@spam.example\r\nSubject: Old spam\r\nMessage-ID: <o@spam.example>\r\n\r\nx")
	f.add("Hello")
	sync := func() {
		if _, err := Sync(ctx, f.pool, store, master, f.id, func(int64) {}); err != nil {
			t.Fatal(err)
		}
	}
	sync()
	q := db.New(f.pool)
	news, yes, no := msg.MessageUpdateCategoryNewsletters, true, false
	if err := Update(ctx, q, master, msg.MessageUpdate{AccountId: f.id, MessageId: f.find(t, "Hello").ID, Category: &news}); err != nil {
		t.Fatal(err)
	}
	var got string
	_ = f.pool.QueryRow(ctx, `SELECT category FROM message WHERE id = $1`, f.find(t, "Hello").ID).Scan(&got)
	if got != "newsletters" {
		t.Fatalf("category %q", got)
	}
	for _, c := range []struct {
		spam *bool
		role string
	}{{&yes, "junk"}, {&no, "inbox"}} {
		if err := Update(ctx, q, master, msg.MessageUpdate{AccountId: f.id, MessageId: f.find(t, "Hello").ID, Spam: c.spam}); err != nil {
			t.Fatal(err)
		}
		sync()
		if m := f.find(t, "Hello"); m.Role != c.role {
			t.Fatalf("spam %v: in %q, want %q", *c.spam, m.Role, c.role)
		}
	}
}
