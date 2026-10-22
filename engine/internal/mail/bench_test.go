// SPDX-License-Identifier: AGPL-3.0-only

package mail

import (
	"bytes"
	"cmp"
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"net"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/emersion/go-imap/v2/imapclient"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/db"
	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/msg"
	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/netsim"
)

// The sync benchmarks run against a real IMAP server, the database and S3, with a proxy in front of the IMAP server
// that adds the round trip time of a provider on the internet:
//
//	docker compose --profile bench up -d
//	set -a && . ../.env && set +a
//	IMAP_SERVER=127.0.0.1:31143 go test -run '^$' -bench . -benchtime 5x ./internal/mail
//
// BENCH_RTT picks the round trip times, "0,20ms,50ms,100ms" by default. Without S3_ENDPOINT nothing is uploaded.

// The big account: about 9,000 messages in 10 folders, the size of a few years of personal mail.
var bigFolders = map[string]int{
	"INBOX": 5000, "Sent": 1000, "Archive": 2600, "Drafts": 20, "Trash": 100, "Junk": 80,
	"Newsletters": 50, "Receipts": 50, "Projects/Alpha": 50, "Projects/Beta": 50,
}

// The small account for first syncs: 1,000 messages in 5 folders.
var smallFolders = map[string]int{"INBOX": 800, "Sent": 80, "Archive": 80, "Trash": 20, "Receipts": 20}

func BenchmarkSync(b *testing.B) {
	env := benchEnv(b)
	big := env.mailbox(b, bigFolders)
	small := env.mailbox(b, smallFolders)
	// Synced once without delay, so the timed runs only see what changed.
	bigAcc := env.account(b, big, env.imap)
	if _, err := Sync(env.ctx, env.pool, env.put, env.master, bigAcc, func(int64) {}); err != nil {
		b.Fatal(err)
	}
	for _, rtt := range rtts() {
		addr := env.imap
		if rtt > 0 {
			addr = netsim.Proxy(b, env.imap, rtt)
		}
		env.point(b, bigAcc, addr)
		// Connects through the proxy; the runs below find the connection kept, as a sync shortly after another does.
		if _, err := Sync(env.ctx, env.pool, env.put, env.master, bigAcc, func(int64) {}); err != nil {
			b.Fatal(err)
		}
		name := fmt.Sprintf("rtt=%s", rtt)
		b.Run("first/1000/"+name, func(b *testing.B) {
			for b.Loop() {
				b.StopTimer()
				id := env.account(b, small, addr)
				b.StartTimer()
				if _, err := Sync(env.ctx, env.pool, env.put, env.master, id, func(int64) {}); err != nil {
					b.Fatal(err)
				}
			}
		})
		b.Run("unchanged/9000/"+name, func(b *testing.B) {
			for b.Loop() {
				if _, err := Sync(env.ctx, env.pool, env.put, env.master, bigAcc, func(int64) {}); err != nil {
					b.Fatal(err)
				}
			}
		})
		b.Run("newmail/9000/"+name, func(b *testing.B) {
			for b.Loop() {
				b.StopTimer()
				big.append(b, "INBOX", newsletter(rand.Text()))
				b.StartTimer()
				if _, err := Sync(env.ctx, env.pool, env.put, env.master, bigAcc, func(int64) {}); err != nil {
					b.Fatal(err)
				}
			}
		})
		b.Run("newmail-cold/9000/"+name, func(b *testing.B) {
			for b.Loop() {
				b.StopTimer()
				big.append(b, "INBOX", newsletter(rand.Text()))
				// As after a long quiet time, when the kept connection is closed already.
				kept.Lock()
				for id, k := range kept.m {
					k.timer.Stop()
					_ = k.c.Close()
					delete(kept.m, id)
				}
				kept.Unlock()
				b.StartTimer()
				if _, err := Sync(env.ctx, env.pool, env.put, env.master, bigAcc, func(int64) {}); err != nil {
					b.Fatal(err)
				}
			}
		})
		b.Run("markread/9000/"+name, func(b *testing.B) {
			q := db.New(env.pool)
			var id string
			if err := env.pool.QueryRow(env.ctx, `SELECT m.id FROM message m JOIN mailbox b ON b.id = m.mailbox_id
				WHERE m.account_id = $1 AND b.name = 'INBOX' ORDER BY m.uid DESC LIMIT 1`, bigAcc).Scan(&id); err != nil {
				b.Fatal(err)
			}
			seen := false
			for b.Loop() {
				// What a click in a client costs until the change is saved, as the engine runs it: the command to the
				// server, then a sync unless the command saved it already.
				seen = !seen
				cmd := msg.MessageUpdate{AccountId: bigAcc, MessageId: id, Seen: &seen}
				if err := Update(env.ctx, q, env.master, cmd); err != nil {
					b.Fatal(err)
				}
				if Saved(cmd) {
					continue
				}
				if _, err := Sync(env.ctx, env.pool, env.put, env.master, bigAcc, func(int64) {}); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}

// BenchmarkContent is the CPU spent reading one message, without any I/O.
func BenchmarkContent(b *testing.B) {
	for name, raw := range map[string][]byte{"text": reply("x", "y"), "newsletter": newsletter("x"), "attachment": withFile("x")} {
		b.Run(name, func(b *testing.B) {
			b.SetBytes(int64(len(raw)))
			for b.Loop() {
				p, _ := Content(raw)
				_, _ = p.columns()
				_ = References(raw)
			}
		})
	}
}

type benchmark struct {
	ctx    context.Context
	pool   *pgxpool.Pool
	put    Put
	master []byte
	imap   string
	secret []byte
}

// benchEnv connects to IMAP_SERVER and the database, and to S3 if S3_ENDPOINT is set.
func benchEnv(b testing.TB) *benchmark {
	if os.Getenv("IMAP_SERVER") == "" || os.Getenv("DATABASE_URL") == "" {
		b.Skip("IMAP_SERVER or DATABASE_URL not set")
	}
	b.Setenv("MAIL_INSECURE_TLS", "1")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		b.Fatal(err)
	}
	b.Cleanup(pool.Close)
	put := func(context.Context, string, []byte, string) error { return nil }
	if os.Getenv("S3_ENDPOINT") != "" {
		if put, _, err = Bucket(ctx); err != nil {
			b.Fatal(err)
		}
	}
	secret, _ := base64.StdEncoding.DecodeString(sealed)
	return &benchmark{ctx, pool, put, bytes.Repeat([]byte{7}, 32), os.Getenv("IMAP_SERVER"), secret}
}

func rtts() []time.Duration {
	var out []time.Duration
	for s := range strings.SplitSeq(cmp.Or(os.Getenv("BENCH_RTT"), "0,20ms,50ms,100ms"), ",") {
		d, _ := time.ParseDuration(s)
		out = append(out, d)
	}
	return out
}

// account adds a mail_account for an IMAP user, unsynced.
func (e *benchmark) account(b testing.TB, m *imapUser, addr string) string {
	id := rand.Text()
	if _, err := e.pool.Exec(e.ctx, `INSERT INTO "user" (id, name, email, created_at, updated_at) VALUES ($1, 'Bench', $1 || '@bench', now(), now())`, id); err != nil {
		b.Fatal(err)
	}
	b.Cleanup(func() {
		_, _ = e.pool.Exec(context.Background(), `DELETE FROM change_log WHERE account_id = $1`, id)
		_, _ = e.pool.Exec(context.Background(), `DELETE FROM "user" WHERE id = $1`, id)
	})
	if _, err := e.pool.Exec(e.ctx, `INSERT INTO mail_account (id, user_id, email, imap_host, imap_port, smtp_host, smtp_port, username, secret)
		VALUES ($1, $1, $2 || '@bench', '127.0.0.1', 0, '127.0.0.1', 25, $2, $3)`, id, m.name, e.secret); err != nil {
		b.Fatal(err)
	}
	e.point(b, id, addr)
	return id
}

// point lets an account connect through addr.
func (e *benchmark) point(b testing.TB, id, addr string) {
	host, port, _ := net.SplitHostPort(addr)
	if _, err := e.pool.Exec(e.ctx, `UPDATE mail_account SET imap_host = $2, imap_port = $3 WHERE id = $1`, id, host, port); err != nil {
		b.Fatal(err)
	}
}

type imapUser struct {
	name string
	c    *imapclient.Client
}

// mailbox creates an IMAP user with the folders filled with a mix of mail.
func (e *benchmark) mailbox(b testing.TB, folders map[string]int) *imapUser {
	name := strings.ToLower(rand.Text())
	var wg sync.WaitGroup
	for folder, n := range folders {
		wg.Go(func() {
			c := e.dial(b, name)
			defer func() { _ = c.Logout().Wait() }()
			if folder != "INBOX" {
				if err := c.Create(folder, nil).Wait(); err != nil {
					b.Error(err)
					return
				}
			}
			for i := range n {
				(&imapUser{name, c}).append(b, folder, mixedMail(i, folder))
			}
		})
	}
	wg.Wait()
	return &imapUser{name, e.dial(b, name)}
}

func (e *benchmark) dial(b testing.TB, user string) *imapclient.Client {
	host, port, _ := net.SplitHostPort(e.imap)
	var p int
	_, _ = fmt.Sscan(port, &p)
	c, err := DialIMAP(host, p, user, "hunter2", nil)
	if err != nil {
		b.Fatal(err)
	}
	return c
}

func (u *imapUser) append(b testing.TB, folder string, raw []byte) {
	cmd := u.c.Append(folder, int64(len(raw)), nil)
	if _, err := cmd.Write(raw); err != nil {
		b.Fatal(err)
	}
	if err := cmd.Close(); err != nil {
		b.Fatal(err)
	}
	if _, err := cmd.Wait(); err != nil {
		b.Fatal(err)
	}
}

// mixedMail is the i-th message of a folder: mostly short conversations, every 4th a newsletter, every 25th with an
// attachment.
func mixedMail(i int, folder string) []byte {
	id := fmt.Sprintf("%s-%d", strings.ReplaceAll(folder, "/", "-"), i)
	switch {
	case i%25 == 0:
		return withFile(id)
	case i%4 == 0:
		return newsletter(id)
	default:
		return reply(id, fmt.Sprintf("%s-%d", strings.ReplaceAll(folder, "/", "-"), i-1))
	}
}

func reply(id, parent string) []byte {
	return fmt.Appendf(nil, "From: Lena Hartmann <lena@example.com>\r\nTo: Max <max@example.com>\r\nSubject: Re: Keys for the new flat %s\r\n"+
		"Date: Thu, 8 Oct 2026 09:12:00 +0200\r\nMessage-ID: <%s@example.com>\r\nIn-Reply-To: <%s@example.com>\r\n"+
		"References: <%s@example.com>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n%s",
		id, id, parent, parent, strings.Repeat("Sounds good, I'll pick them up on Saturday around ten.\r\n", 12))
}

func newsletter(id string) []byte {
	html := "<html><head><style>p{color:#333}</style></head><body>" +
		strings.Repeat(`<table><tr><td><p>Autumn sale: 30% off all jackets, <a href="https://shop.example/x">shop now</a>.</p></td></tr></table>`, 200) +
		"</body></html>"
	return fmt.Appendf(nil, "From: Shop <news@shop.example>\r\nTo: max@example.com\r\nSubject: Autumn sale %s\r\n"+
		"Date: Thu, 8 Oct 2026 09:12:00 +0200\r\nMessage-ID: <%s@shop.example>\r\nList-Unsubscribe: <https://shop.example/u>\r\n"+
		"MIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary=b\r\n\r\n"+
		"--b\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n30%% off all jackets.\r\n--b\r\nContent-Type: text/html; charset=utf-8\r\n\r\n%s\r\n--b--\r\n",
		id, id, html)
}

func withFile(id string) []byte {
	pdf := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte("%PDF-1.7 invoice "), 12000))
	var wrapped strings.Builder
	for i := 0; i < len(pdf); i += 76 {
		wrapped.WriteString(pdf[i:min(i+76, len(pdf))] + "\r\n")
	}
	return fmt.Appendf(nil, "From: Billing <billing@power.example>\r\nTo: max@example.com\r\nSubject: Your invoice %s\r\n"+
		"Date: Thu, 8 Oct 2026 09:12:00 +0200\r\nMessage-ID: <%s@power.example>\r\nMIME-Version: 1.0\r\n"+
		"Content-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nYour invoice is attached.\r\n"+
		"--b\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename=invoice.pdf\r\nContent-Transfer-Encoding: base64\r\n\r\n%s--b--\r\n",
		id, id, wrapped.String())
}
