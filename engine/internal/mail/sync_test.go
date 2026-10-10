// SPDX-License-Identifier: AGPL-3.0-only

package mail

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"fmt"
	"math/big"
	"net"
	"os"
	"slices"
	"testing"
	"time"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapserver"
	"github.com/emersion/go-imap/v2/imapserver/imapmemserver"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/db"
	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/msg"
)

// "hunter2" sealed with a master key of 32 bytes of 7, same vector as in the secret package.
const sealed = "AeVCfofwDm5ahJCtI82tdCIIVvFGf4BwyDIroAsv8BzQ4CPCXPqq675SlWplhAG7PyMZWGLwU3IYPM2t518oWtrlmqUm0PUvih+KsT87w8xD94X40wD1NabVp54hDhIi"

// fixture is an IMAP server with one user and a mail_account row pointing at it.
type fixture struct {
	pool *pgxpool.Pool
	id   string
	add  func(subject string)
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
	srv := imapserver.New(&imapserver.Options{
		NewSession: func(*imapserver.Conn) (imapserver.Session, *imapserver.GreetingData, error) {
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
	return fixture{pool, id, add}
}

func TestSync(t *testing.T) {
	f := setup(t)
	ctx, pool, id, add := context.Background(), f.pool, f.id, f.add
	add("Keys for the new flat")
	add("Saturday")

	master := bytes.Repeat([]byte{7}, 32)
	stored := map[string][]byte{}
	put := func(_ context.Context, key string, data []byte, _ string) error {
		stored[key] = data
		return nil
	}
	// INBOX and Trash, then the two messages.
	for _, want := range []int64{4, 4} {
		if v, err := Sync(ctx, pool, put, master, id); err != nil || v != want {
			t.Fatalf("version %d, %v; want %d", v, err, want)
		}
	}
	add("Invoice")
	if v, err := Sync(ctx, pool, put, master, id); err != nil || v != 5 {
		t.Fatalf("version %d, %v; want 5", v, err)
	}
	var roles []string
	_ = pool.QueryRow(ctx, `SELECT array_agg(name || ':' || role ORDER BY name) FROM mailbox WHERE account_id = $1`, id).Scan(&roles)
	if !slices.Equal(roles, []string{"INBOX:inbox", "Trash:trash"}) {
		t.Fatalf("roles %v", roles)
	}
	var msgID, from, subject, snippet string
	if err := pool.QueryRow(ctx, `SELECT id, from_addr, subject, snippet FROM message WHERE account_id = $1 ORDER BY uid LIMIT 1`, id).Scan(&msgID, &from, &subject, &snippet); err != nil {
		t.Fatal(err)
	}
	if from != "lena@example.com" || subject != "Keys for the new flat" || snippet != "Hi" {
		t.Fatalf("got %q %q %q", from, subject, snippet)
	}
	if len(stored) != 6 || !bytes.Contains(stored["raw/"+msgID+".eml"], []byte("Subject: Keys for the new flat")) || !bytes.Contains(stored["body/"+msgID+".html"], []byte(">Hi</div>")) {
		t.Fatalf("stored %d objects", len(stored))
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
	if _, err := Sync(ctx, f.pool, put, master, f.id); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(ctx, `UPDATE mailbox SET uid_validity = uid_validity + 1 WHERE account_id = $1`, f.id); err != nil {
		t.Fatal(err)
	}
	// Both folders were renumbered: both old rows are deleted, both messages come back as new rows, and both
	// folders are logged as changed.
	if v, err := Sync(ctx, f.pool, put, master, f.id); err != nil || v != 10 {
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
	if _, err := Sync(ctx, f.pool, put, master, f.id); err != nil {
		t.Fatal(err)
	}
	ids := map[string]string{}
	rows, _ := f.pool.Query(ctx, `SELECT subject, id FROM message WHERE account_id = $1`, f.id)
	for rows.Next() {
		var subject, id string
		_ = rows.Scan(&subject, &id)
		ids[subject] = id
	}
	yes := true
	if err := Update(ctx, q, master, msg.MessageUpdate{AccountId: f.id, MessageId: ids["Read me"], Seen: &yes}); err != nil {
		t.Fatal(err)
	}
	if err := Update(ctx, q, master, msg.MessageUpdate{AccountId: f.id, MessageId: ids["Throw me away"], Trash: &yes}); err != nil {
		t.Fatal(err)
	}
	// One flag change, one message gone from the INBOX and the same one new in Trash.
	if v, err := Sync(ctx, f.pool, put, master, f.id); err != nil || v != 7 {
		t.Fatalf("version %d, %v; want 7", v, err)
	}
	f.add("Keep me")
	if _, err := Sync(ctx, f.pool, put, master, f.id); err != nil {
		t.Fatal(err)
	}
	var keep string
	_ = f.pool.QueryRow(ctx, `SELECT id FROM message WHERE account_id = $1 AND subject = 'Keep me'`, f.id).Scan(&keep)
	// No archive folder on the test server: it gets created.
	if err := Update(ctx, q, master, msg.MessageUpdate{AccountId: f.id, MessageId: keep, Archive: &yes}); err != nil {
		t.Fatal(err)
	}
	if _, err := Sync(ctx, f.pool, put, master, f.id); err != nil {
		t.Fatal(err)
	}
	var archived int
	_ = f.pool.QueryRow(ctx, `SELECT count(*) FROM message m JOIN mailbox b ON b.id = m.mailbox_id WHERE m.account_id = $1 AND b.role = 'archive' AND m.subject = 'Keep me'`, f.id).Scan(&archived)
	if archived != 1 {
		t.Fatal("archived message not in Archive")
	}
	var inTrash int
	_ = f.pool.QueryRow(ctx, `SELECT count(*) FROM message m JOIN mailbox b ON b.id = m.mailbox_id WHERE m.account_id = $1 AND b.role = 'trash' AND m.subject = 'Throw me away'`, f.id).Scan(&inTrash)
	if inTrash != 1 {
		t.Fatal("trashed message not in Trash")
	}
	var flags []string
	if err := f.pool.QueryRow(ctx, `SELECT flags FROM message WHERE id = $1`, ids["Read me"]).Scan(&flags); err != nil || !slices.Equal(flags, []string{`\Seen`}) {
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
	go func() {
		Watch(ctx, db.New(f.pool), bytes.Repeat([]byte{7}, 32), f.id, func() { calls <- struct{}{} })
		close(done)
	}()
	wait := func(what string) {
		select {
		case <-calls:
		case <-time.After(5 * time.Second):
			t.Fatal("no call " + what)
		}
	}
	wait("after connecting")
	f.add("Invoice")
	wait("for new mail")
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Watch didn't return after cancel")
	}
}

func TestSaveSent(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	raw, _ := Compose("lena@example.com", msg.MessageSend{To: []string{"a@x.example"}, Subject: "Hi", Text: "Hi"}, "", nil, time.Now())
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
