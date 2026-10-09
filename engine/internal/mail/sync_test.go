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
	"testing"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapserver"
	"github.com/emersion/go-imap/v2/imapserver/imapmemserver"
	"github.com/jackc/pgx/v5/pgxpool"
)

// "hunter2" sealed with a master key of 32 bytes of 7, same vector as in the secret package.
const sealed = "AeVCfofwDm5ahJCtI82tdCIIVvFGf4BwyDIroAsv8BzQ4CPCXPqq675SlWplhAG7PyMZWGLwU3IYPM2t518oWtrlmqUm0PUvih+KsT87w8xD94X40wD1NabVp54hDhIi"

// Needs a migrated database (docker compose up -d postgres && bun run db:migrate).
func TestSync(t *testing.T) {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		t.Skip("DATABASE_URL not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()

	mem := imapmemserver.New()
	u := imapmemserver.NewUser("lena", "hunter2")
	mem.AddUser(u)
	if err := u.Create("INBOX", nil); err != nil {
		t.Fatal(err)
	}
	add := func(subject string) {
		raw := fmt.Sprintf("From: Lena Hartmann <lena@example.com>\r\nSubject: %s\r\nDate: Thu, 8 Oct 2026 09:12:00 +0200\r\nMessage-ID: <%s@example.com>\r\n\r\nHi", subject, rand.Text())
		if _, err := u.Append("INBOX", bytes.NewReader([]byte(raw)), &imap.AppendOptions{}); err != nil {
			t.Fatal(err)
		}
	}
	add("Keys for the new flat")
	add("Saturday")

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := imapserver.New(&imapserver.Options{
		NewSession: func(*imapserver.Conn) (imapserver.Session, *imapserver.GreetingData, error) {
			return mem.NewSession(), nil, nil
		},
		Caps:      imap.CapSet{imap.CapIMAP4rev1: {}},
		TLSConfig: selfSigned(t),
	})
	go func() { _ = srv.Serve(ln) }()
	defer func() { _ = srv.Close() }()
	t.Setenv("IMAP_INSECURE_TLS", "1")

	id := rand.Text()
	secret, _ := base64.StdEncoding.DecodeString(sealed)
	port := ln.Addr().(*net.TCPAddr).Port
	if _, err := pool.Exec(ctx, `INSERT INTO "user" (id, name, email, created_at, updated_at) VALUES ($1, 'Lena', $1 || '@test', now(), now())`, id); err != nil {
		t.Fatal(err)
	}
	defer func() { _, _ = pool.Exec(ctx, `DELETE FROM "user" WHERE id = $1`, id) }()
	if _, err := pool.Exec(ctx, `INSERT INTO mail_account (id, user_id, email, imap_host, imap_port, smtp_host, smtp_port, username, secret)
		VALUES ($1, $1, 'lena@example.com', '127.0.0.1', $2, '127.0.0.1', 25, 'lena', $3)`, id, port, secret); err != nil {
		t.Fatal(err)
	}

	master := bytes.Repeat([]byte{7}, 32)
	for _, want := range []int64{2, 2} {
		if v, err := Sync(ctx, pool, master, id); err != nil || v != want {
			t.Fatalf("version %d, %v; want %d", v, err, want)
		}
	}
	add("Invoice")
	if v, err := Sync(ctx, pool, master, id); err != nil || v != 3 {
		t.Fatalf("version %d, %v; want 3", v, err)
	}
	var from, subject string
	if err := pool.QueryRow(ctx, `SELECT from_addr, subject FROM message WHERE account_id = $1 ORDER BY uid LIMIT 1`, id).Scan(&from, &subject); err != nil {
		t.Fatal(err)
	}
	if from != "lena@example.com" || subject != "Keys for the new flat" {
		t.Fatalf("got %q %q", from, subject)
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
