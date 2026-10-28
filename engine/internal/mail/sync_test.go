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
	"errors"
	"fmt"
	"math/big"
	mathrand "math/rand/v2"
	"net"
	"os"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
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
	pool *pgxpool.Pool
	id   string
	add  func(subject string)
	// addSeen adds a message that was read elsewhere already.
	addSeen func(subject string)
	addRaw  func(raw string)
	key     *ecdh.PrivateKey
	// cut closes every open connection, like a server ending an idle one.
	cut func()
	// appendTo puts a message into a folder, made if it isn't there.
	appendTo func(box, raw string)
	// silent makes the server stop answering on the connections it has, or answer again.
	silent *atomic.Bool
}

// muted holds back what the server writes while silent is set.
type muted struct {
	net.Conn
	silent *atomic.Bool
}

func (c muted) Write(b []byte) (int, error) {
	for c.silent.Load() {
		time.Sleep(10 * time.Millisecond)
	}
	return c.Conn.Write(b)
}

type mutedListener struct {
	net.Listener
	silent *atomic.Bool
}

func (l mutedListener) Accept() (net.Conn, error) {
	c, err := l.Listener.Accept()
	return muted{c, l.silent}, err
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
	addWith := func(subject string, flags ...imap.Flag) {
		raw := fmt.Sprintf("From: Lena Hartmann <lena@example.com>\r\nSubject: %s\r\nDate: Thu, 8 Oct 2026 09:12:00 +0200\r\nMessage-ID: <%s@example.com>\r\n\r\nHi", subject, rand.Text())
		if _, err := u.Append("INBOX", bytes.NewReader([]byte(raw)), &imap.AppendOptions{Flags: flags}); err != nil {
			t.Error(err)
		}
	}
	add := func(subject string) { addWith(subject) }
	addSeen := func(subject string) { addWith(subject, imap.FlagSeen) }

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
	silent := &atomic.Bool{}
	go func() { _ = srv.Serve(mutedListener{ln, silent}) }()
	t.Cleanup(func() {
		silent.Store(false)
		_ = srv.Close()
	})
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
	return fixture{pool, id, add, addSeen, addRaw, key, cut, appendTo, silent}
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
		if v, err := Sync(ctx, pool, Store{Put: put, Drop: noDrop}, master, id, func(int64, []string) {}); err != nil || v != want {
			t.Fatalf("version %d, %v; want %d", v, err, want)
		}
	}
	add("Invoice")
	if v, err := Sync(ctx, pool, Store{Put: put, Drop: noDrop}, master, id, func(int64, []string) {}); err != nil || v != 5 {
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
	if _, err := Sync(ctx, f.pool, store, master, f.id, func(int64, []string) {}); err != nil {
		t.Fatal(err)
	}
	_, _ = f.pool.Exec(ctx, `DELETE FROM user_key WHERE user_id = $1`, f.id)
	if _, err := Sync(ctx, f.pool, store, master, f.id, func(int64, []string) {}); err != nil {
		t.Fatal(err)
	}
	if len(f.messages(t)) != 0 || len(dropped) != 1 {
		t.Fatalf("%d messages left, %d dropped", len(f.messages(t)), len(dropped))
	}
	f.key, _ = ecdh.X25519().GenerateKey(rand.Reader)
	_, _ = f.pool.Exec(ctx, `INSERT INTO user_key (user_id, public_key, wrapped_private) VALUES ($1, $2, '')`, f.id, f.key.PublicKey().Bytes())
	if _, err := Sync(ctx, f.pool, store, master, f.id, func(int64, []string) {}); err != nil {
		t.Fatal(err)
	}
	if m := f.messages(t); len(m) != 1 || m[0].Subject != "Before the reset" {
		t.Fatalf("got %+v", m)
	}
}

// New mail in an inbox is announced once, if unread and not part of a folder's first sync.
func TestArrived(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	store := Store{Put: func(context.Context, string, []byte, string) error { return nil }, Drop: noDrop}
	master := bytes.Repeat([]byte{7}, 32)
	sync := func(what string, want ...string) {
		t.Helper()
		var got []string
		if _, err := Sync(ctx, f.pool, store, master, f.id, func(_ int64, ids []string) { got = append(got, ids...) }); err != nil {
			t.Fatal(what, err)
		}
		var subjects []string
		for _, id := range got {
			for _, m := range f.messages(t) {
				if m.ID == id {
					subjects = append(subjects, m.Subject)
				}
			}
		}
		if !slices.Equal(subjects, want) {
			t.Fatalf("%s: announced %v, want %v", what, subjects, want)
		}
	}
	mail := func(subject string) string {
		return fmt.Sprintf("From: Lena <lena@example.com>\r\nSubject: %s\r\nMessage-ID: <%s@example.com>\r\n\r\nHi", subject, rand.Text())
	}
	f.add("Old")
	f.appendTo("Archive", mail("Old archived"))
	sync("first sync")
	f.add("New")
	f.addSeen("Read elsewhere")
	f.appendTo("Archive", mail("Archived"))
	sync("new mail", "New")
	sync("nothing new")
	_, _ = f.pool.Exec(ctx, `UPDATE user_key SET public_key = $2 WHERE user_id = $1`, f.id, func() []byte {
		f.key, _ = ecdh.X25519().GenerateKey(rand.Reader)
		return f.key.PublicKey().Bytes()
	}())
	f.add("After a reset")
	sync("everything again after a reset")
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
	if _, err := Sync(ctx, f.pool, Store{Put: put, Drop: noDrop}, master, f.id, func(int64, []string) {}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(ctx, `UPDATE mailbox SET uid_validity = uid_validity + 1 WHERE account_id = $1`, f.id); err != nil {
		t.Fatal(err)
	}
	// Both folders were renumbered: both old rows are deleted, both messages come back as new rows, and both
	// folders are logged as changed.
	if v, err := Sync(ctx, f.pool, Store{Put: put, Drop: noDrop}, master, f.id, func(int64, []string) {}); err != nil || v != 10 {
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
	if _, err := Sync(ctx, f.pool, Store{Put: put, Drop: noDrop}, master, f.id, func(int64, []string) {}); err != nil {
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
	if v, err := Sync(ctx, f.pool, Store{Put: put, Drop: noDrop}, master, f.id, func(int64, []string) {}); err != nil || v != 7 {
		t.Fatalf("version %d, %v; want 7", v, err)
	}
	f.add("Keep me")
	if _, err := Sync(ctx, f.pool, Store{Put: put, Drop: noDrop}, master, f.id, func(int64, []string) {}); err != nil {
		t.Fatal(err)
	}
	keep := f.find(t, "Keep me").ID
	// No archive folder on the test server: it gets created.
	if err := Update(ctx, q, master, msg.MessageUpdate{AccountId: f.id, MessageId: keep, Archive: &yes}); err != nil {
		t.Fatal(err)
	}
	if _, err := Sync(ctx, f.pool, Store{Put: put, Drop: noDrop}, master, f.id, func(int64, []string) {}); err != nil {
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

// A sync stuck on its connection ends with an error, so the account's next command can run.
func TestSyncStall(t *testing.T) {
	f := setup(t)
	defer func(d time.Duration) { stall = d }(stall)
	stall = time.Second
	master := bytes.Repeat([]byte{7}, 32)
	store := Store{Put: func(context.Context, string, []byte, string) error { return nil }, Drop: noDrop}
	f.add("Invoice")
	if _, err := Sync(context.Background(), f.pool, store, master, f.id, func(int64, []string) {}); err != nil {
		t.Fatal(err)
	}
	// The kept connection is taken again, then nothing comes back on it; go-imap alone would wait forever.
	f.silent.Store(true)
	start := time.Now()
	if _, err := Sync(context.Background(), f.pool, store, master, f.id, func(int64, []string) {}); err == nil {
		t.Fatal("a sync on a silent server succeeded")
	}
	if d := time.Since(start); d > 10*time.Second {
		t.Fatalf("took %v to give up", d)
	}
	f.silent.Store(false)
	f.add("Receipt")
	if _, err := Sync(context.Background(), f.pool, store, master, f.id, func(int64, []string) {}); err != nil {
		t.Fatal("after the server answers again:", err)
	}
	if f.find(t, "Receipt").ID == "" {
		t.Fatal("new mail missing after the stall")
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
	raw, _ := Compose(mail.Address{Address: "lena@example.com"}, msg.MessageSend{To: []string{"a@x.example"}, Subject: "Hi", Text: "Hi"}, "", nil, time.Now(), false)
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
	v, err := Sync(ctx, f.pool, Store{Put: put, Drop: noDrop}, bytes.Repeat([]byte{7}, 32), f.id, func(v int64, _ []string) { saves = append(saves, v) })
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
		if _, err := Sync(ctx, f.pool, Store{Put: put, Drop: noDrop}, master, f.id, func(int64, []string) {}); err != nil {
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
		if _, err := Sync(ctx, f.pool, Store{Put: put, Drop: noDrop}, master, f.id, func(int64, []string) {}); err != nil {
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
	draft := f.id + "-d1"
	files := map[string][]byte{"upload/" + f.id + "/f1": []byte("%PDF-1")}
	get := func(_ context.Context, key string) ([]byte, error) {
		if b, ok := files[key]; ok {
			return b, nil
		}
		return nil, errors.New("no such file")
	}
	save := func(text string, rev int, discard bool) {
		t.Helper()
		d := msg.DraftSave{AccountId: f.id, DraftId: draft, To: []string{"a@x.example"}, Cc: []string{}, Bcc: []string{"b@x.example"},
			Subject: "Plan", Text: text, Rev: &rev, Attachments: []msg.DraftSaveAttachmentsElem{{Id: "f1", Name: "Plan.pdf", Type: "application/pdf"}}}
		if discard {
			d.Discard = &discard
		}
		if err := SaveDraft(ctx, q, get, master, d, "upload/"+f.id+"/"); err != nil {
			t.Fatal(err)
		}
	}
	acc, _ := q.GetAccount(ctx, f.id)
	drafts := func() []string {
		t.Helper()
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
		var all imap.SeqSet
		all.AddRange(1, 0)
		msgs, _ := c.Fetch(all, &imap.FetchOptions{BodySection: []*imap.FetchItemBodySection{whole}}).Collect()
		var out []string
		for _, m := range msgs {
			raw := m.FindBodySection(whole)
			p, _ := Content(raw)
			if !strings.Contains(string(raw), "Bcc: <b@x.example>") || len(p.Files) != 1 || p.Files[0].Name != "Plan.pdf" {
				t.Fatalf("draft without its Bcc or file:\n%s", raw)
			}
			out = append(out, p.Snippet)
		}
		return out
	}
	save("first", 1, false)
	save("second", 2, false)
	if got := drafts(); !slices.Equal(got, []string{"second"}) {
		t.Fatalf("drafts %v", got)
	}
	// An older save that was retried arrives last; the newer text stays.
	save("first", 1, false)
	if got := drafts(); !slices.Equal(got, []string{"second"}) {
		t.Fatalf("drafts %v after a late older save", got)
	}
	save("", 3, true)
	if got := drafts(); len(got) != 0 {
		t.Fatalf("drafts %v after discard", got)
	}
	// Sent meanwhile: a save still on its way doesn't bring the draft back.
	if _, err := q.StartSend(ctx, db.StartSendParams{DraftID: draft, AccountID: f.id, Payload: []byte{}}); err != nil {
		t.Fatal(err)
	}
	_ = q.EndSend(ctx, db.EndSendParams{DraftID: draft, State: "sent"})
	save("third", 4, false)
	if got := drafts(); len(got) != 0 {
		t.Fatalf("drafts %v after the message was sent", got)
	}
}

// syncWithin syncs the account and fails the test if that errs or doesn't return: prod once waited forever.
func (e *benchmark) syncWithin(t *testing.T, id, what string) int64 {
	t.Helper()
	type result struct {
		v   int64
		err error
	}
	done := make(chan result, 1)
	go func() {
		v, err := Sync(e.ctx, e.pool, Store{Put: e.put, Drop: noDrop}, e.master, id, func(int64, []string) {})
		done <- result{v, err}
	}()
	select {
	case r := <-done:
		if r.err != nil {
			t.Fatal(what, r.err)
		}
		return r.v
	case <-time.After(20 * time.Second):
		t.Fatal(what, ": sync hangs")
		return 0
	}
}

// sameAsServer fails the test unless the database holds exactly the server's messages and flags in the folders.
func (e *benchmark) sameAsServer(t *testing.T, u *imapUser, id, what string, folders ...string) {
	t.Helper()
	for _, folder := range folders {
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
		v := e.syncWithin(t, id, what)
		if changes >= 0 && v-version != changes {
			t.Errorf("%s: %d changes, want %d", what, v-version, changes)
		}
		version = v
		e.sameAsServer(t, u, id, what, "INBOX", "Archive")
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

// New mail that's gone again before the sync, like one archived in Gmail right away: the folder's UIDNEXT moved on,
// but its newest message is still one we have. Prod synced Gmail and Purelymail accounts this way and never returned.
func TestSyncNewestGone(t *testing.T) {
	e := benchEnv(t)
	u := e.mailbox(t, map[string]int{"INBOX": 5, "Archive": 0})
	if !u.c.Caps().Has(imap.CapCondStore) {
		t.Skip("server without CONDSTORE")
	}
	id := e.account(t, u, e.imap)
	e.syncWithin(t, id, "first sync")
	u.append(t, "INBOX", reply("gone", "INBOX-0"))
	if _, err := u.c.Select("INBOX", nil).Wait(); err != nil {
		t.Fatal(err)
	}
	if err := u.c.Store(imap.UIDSetNum(1), &imap.StoreFlags{Op: imap.StoreFlagsAdd, Silent: true, Flags: []imap.Flag{imap.FlagSeen}}, nil).Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := u.c.Move(imap.UIDSetNum(6), "Archive").Wait(); err != nil {
		t.Fatal(err)
	}
	e.syncWithin(t, id, "newest gone")
	e.sameAsServer(t, u, id, "newest gone", "INBOX", "Archive")
}

// TestSyncConverges changes a mailbox at random between syncs, the way people and their other mail apps do, and
// checks after every sync that the database matches the server. The seed is logged; SEED=n replays a run.
func TestSyncConverges(t *testing.T) {
	e := benchEnv(t)
	u := e.mailbox(t, map[string]int{"INBOX": 8, "Archive": 4})
	if !u.c.Caps().Has(imap.CapCondStore) {
		t.Skip("server without CONDSTORE")
	}
	id := e.account(t, u, e.imap)
	seed, _ := strconv.ParseUint(os.Getenv("SEED"), 10, 64)
	if seed == 0 {
		seed = uint64(time.Now().UnixNano())
	}
	t.Log("SEED", seed)
	r := mathrand.New(mathrand.NewPCG(seed, seed))
	folders := []string{"INBOX", "Archive"}
	flags := []imap.Flag{imap.FlagSeen, imap.FlagFlagged, imap.FlagAnswered}
	uids := func(folder string) []imap.UID {
		if _, err := u.c.Select(folder, nil).Wait(); err != nil {
			t.Fatal(err)
		}
		var all imap.UIDSet
		all.AddRange(1, 0)
		msgs, err := u.c.Fetch(all, &imap.FetchOptions{UID: true}).Collect()
		if err != nil {
			t.Fatal(err)
		}
		var out []imap.UID
		for _, m := range msgs {
			out = append(out, m.UID)
		}
		return out
	}
	e.syncWithin(t, id, "first sync")
	for round := range 40 {
		var did []string
		for range 1 + r.IntN(4) {
			folder := folders[r.IntN(2)]
			have := uids(folder)
			op := r.IntN(5)
			if len(have) == 0 {
				op = 0
			}
			pick := func() imap.UID { return have[r.IntN(len(have))] }
			switch op {
			case 0:
				u.append(t, folder, reply(rand.Text(), "INBOX-0"))
				did = append(did, "new in "+folder)
			case 1:
				f := flags[r.IntN(len(flags))]
				o := []imap.StoreFlagsOp{imap.StoreFlagsAdd, imap.StoreFlagsDel}[r.IntN(2)]
				if err := u.c.Store(imap.UIDSetNum(pick()), &imap.StoreFlags{Op: o, Silent: true, Flags: []imap.Flag{f}}, nil).Close(); err != nil {
					t.Fatal(err)
				}
				did = append(did, fmt.Sprint("flag ", f, " in ", folder))
			case 2:
				to := folders[1-slices.Index(folders, folder)]
				if _, err := u.c.Move(imap.UIDSetNum(pick()), to).Wait(); err != nil {
					t.Fatal(err)
				}
				did = append(did, "move from "+folder)
			case 3:
				if err := u.c.Store(imap.UIDSetNum(pick()), &imap.StoreFlags{Op: imap.StoreFlagsAdd, Silent: true, Flags: []imap.Flag{imap.FlagDeleted}}, nil).Close(); err != nil {
					t.Fatal(err)
				}
				if err := u.c.Expunge().Close(); err != nil {
					t.Fatal(err)
				}
				did = append(did, "delete in "+folder)
			case 4:
				// New and gone again before the sync, the case that hung prod.
				u.append(t, folder, reply(rand.Text(), "INBOX-0"))
				now := uids(folder)
				to := folders[1-slices.Index(folders, folder)]
				if _, err := u.c.Move(imap.UIDSetNum(now[len(now)-1]), to).Wait(); err != nil {
					t.Fatal(err)
				}
				did = append(did, "new and moved from "+folder)
			}
		}
		what := fmt.Sprintf("round %d (%s)", round, strings.Join(did, ", "))
		e.syncWithin(t, id, what)
		e.sameAsServer(t, u, id, what, folders...)
	}
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
	if _, err := Sync(ctx, f.pool, store, master, f.id, func(int64, []string) {}); err != nil {
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
	if _, err := Sync(ctx, f.pool, Store{Put: func(context.Context, string, []byte, string) error { return nil }, Drop: noDrop}, bytes.Repeat([]byte{7}, 32), f.id, func(int64, []string) {}); err != nil {
		t.Fatal(err)
	}
	for subject, want := range map[string]string{
		"Club news": "primary false", "New in": "newsletters false", "Weekly": "promotions false",
		// Phishing too: only the user and the provider call mail spam.
		"Your account has been limited": "primary false",
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
	if _, err := Sync(ctx, f.pool, Store{Put: func(context.Context, string, []byte, string) error { return nil }, Drop: noDrop}, bytes.Repeat([]byte{7}, 32), f.id, func(int64, []string) {}); err != nil {
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
		if _, err := Sync(ctx, f.pool, store, master, f.id, func(int64, []string) {}); err != nil {
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

// Folders of servers without SPECIAL-USE are known by their names, also German ones and ones under INBOX.
func TestRoleByName(t *testing.T) {
	for name, want := range map[string]string{"INBOX.Sent": "sent", "Gesendet": "sent", "Gesendete Elemente": "sent", "INBOX.Drafts": "drafts",
		"Entwürfe": "drafts", "INBOX/Trash": "trash", "Papierkorb": "trash", "Archiv": "archive", "INBOX.Projekte": ""} {
		delim := '.'
		if strings.Contains(name, "/") {
			delim = '/'
		}
		if got := role(&imap.ListData{Mailbox: name, Delim: delim}); got != want {
			t.Errorf("%s: %q, want %q", name, got, want)
		}
	}
}

// Answers go to Reply-To when a mail has one other than its sender.
func TestReplyTo(t *testing.T) {
	f := setup(t)
	f.addRaw("From: Shop <news@shop.example>\r\nReply-To: Support <help@shop.example>\r\nSubject: Order\r\nMessage-ID: <o1@shop.example>\r\n\r\nHi")
	f.addRaw("From: Lena <lena@example.com>\r\nReply-To: lena@example.com\r\nSubject: Same\r\nMessage-ID: <o2@example.com>\r\n\r\nHi")
	store := Store{Put: func(context.Context, string, []byte, string) error { return nil }, Drop: noDrop}
	if _, err := Sync(context.Background(), f.pool, store, bytes.Repeat([]byte{7}, 32), f.id, func(int64, []string) {}); err != nil {
		t.Fatal(err)
	}
	if got := f.find(t, "Order").ReplyTo; got != "help@shop.example" {
		t.Fatalf("reply to %q", got)
	}
	if got := f.find(t, "Same").ReplyTo; got != "" {
		t.Fatalf("reply to %q for the sender's own address", got)
	}
}
