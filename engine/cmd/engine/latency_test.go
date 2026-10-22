// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bytes"
	"cmp"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/emersion/go-imap/v2/imapclient"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"

	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/mail"
	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/msg"
	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/netsim"
)

// "hunter2" sealed with a master key of 32 bytes of 7, same vector as in the secret package.
const sealed = "AeVCfofwDm5ahJCtI82tdCIIVvFGf4BwyDIroAsv8BzQ4CPCXPqq675SlWplhAG7PyMZWGLwU3IYPM2t518oWtrlmqUm0PUvih+KsT87w8xD94X40wD1NabVp54hDhIi"

// TestLatency runs the whole engine and measures what users wait for, with the IMAP server BENCH_RTT away (servers
// as in internal/mail/bench_test.go, plus NATS): from a new mail landing on the server until the engine announces
// it saved it (IDLE, the queue, the sync), and from a client's "mark as read" command until the same.
// Needs IMAP_SERVER, DATABASE_URL, NATS_URL and S3_*; LATENCY_RUNS sets the runs per measurement, 10 by default.
func TestLatency(t *testing.T) {
	imapServer := os.Getenv("IMAP_SERVER")
	if imapServer == "" || os.Getenv("DATABASE_URL") == "" || os.Getenv("NATS_URL") == "" || os.Getenv("S3_ENDPOINT") == "" {
		t.Skip("IMAP_SERVER, DATABASE_URL, NATS_URL or S3_ENDPOINT not set")
	}
	t.Setenv("SECRETS_KEY", base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32)))
	t.Setenv("MAIL_INSECURE_TLS", "1")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	runs, _ := strconv.Atoi(cmp.Or(os.Getenv("LATENCY_RUNS"), "10"))

	// One account per round trip time, each with a small INBOX; the engine finds them when it starts.
	type account struct {
		id, user string
		rtt      time.Duration
	}
	var accounts []account
	secret, _ := base64.StdEncoding.DecodeString(sealed)
	for s := range strings.SplitSeq(cmp.Or(os.Getenv("BENCH_RTT"), "0,20ms,50ms,100ms"), ",") {
		rtt, _ := time.ParseDuration(s)
		a := account{id: rand.Text(), user: strings.ToLower(rand.Text()), rtt: rtt}
		appendMail(t, imapServer, a.user, "First")
		host, port, _ := net.SplitHostPort(netsim.Proxy(t, imapServer, rtt))
		if _, err := pool.Exec(ctx, `INSERT INTO "user" (id, name, email, created_at, updated_at) VALUES ($1, 'Bench', $1 || '@bench', now(), now())`, a.id); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			_, _ = pool.Exec(context.Background(), `DELETE FROM change_log WHERE account_id = $1`, a.id)
			_, _ = pool.Exec(context.Background(), `DELETE FROM "user" WHERE id = $1`, a.id)
		})
		if _, err := pool.Exec(ctx, `INSERT INTO mail_account (id, user_id, email, imap_host, imap_port, smtp_host, smtp_port, username, secret)
			VALUES ($1, $1, $2 || '@bench', $3, $4, '127.0.0.1', 25, $2, $5)`, a.id, a.user, host, port, secret); err != nil {
			t.Fatal(err)
		}
		accounts = append(accounts, a)
	}

	nc, err := nats.Connect(os.Getenv("NATS_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer nc.Close()
	synced := map[string]chan int{}
	for _, a := range accounts {
		synced[a.id] = make(chan int, 100)
	}
	if _, err := nc.Subscribe("evt.mailbox.synced", func(m *nats.Msg) {
		var ev msg.MailboxSynced
		if json.Unmarshal(m.Data, &ev) == nil && ev.Error == nil && synced[ev.AccountId] != nil {
			synced[ev.AccountId] <- ev.Version
		}
	}); err != nil {
		t.Fatal(err)
	}
	go func() {
		if err := run(); err != nil {
			t.Error(err)
		}
	}()
	// Waits for the account to reach a version above since, and returns it.
	await := func(a account, since int) int {
		for {
			select {
			case v := <-synced[a.id]:
				if v > since {
					return v
				}
			case <-time.After(30 * time.Second):
				t.Fatalf("rtt %s: no sync", a.rtt)
			}
		}
	}

	// Waits until the engine was quiet for a while, as before mail that comes in after a quiet moment, and returns the
	// account's version by then.
	settle := func(a account, version int) int {
		for {
			select {
			case v := <-synced[a.id]:
				version = max(version, v)
			case <-time.After(1500 * time.Millisecond):
				return version
			}
		}
	}

	js, _ := jetstream.New(nc)
	t.Logf("%-8s %-30s %10s %10s %10s", "rtt", "", "median", "p90", "max")
	push := pushDelay(t, imapServer, runs)
	t.Logf("%-8s %-30s %10s", "", "server's IDLE push delay", push.Round(time.Millisecond))
	for _, a := range accounts {
		version := settle(a, await(a, 0))
		report := func(what string, took []time.Duration) {
			slices.Sort(took)
			t.Logf("%-8s %-30s %10s %10s %10s", a.rtt, what, took[len(took)/2].Round(time.Millisecond),
				took[len(took)*9/10].Round(time.Millisecond), took[len(took)-1].Round(time.Millisecond))
		}
		var took []time.Duration
		for i := range runs {
			start := appendMail(t, imapServer, a.user, fmt.Sprint("Mail ", i))
			version = await(a, version)
			took = append(took, time.Since(start))
			version = settle(a, version)
		}
		report("new mail until saved", took)

		var id string
		if err := pool.QueryRow(ctx, `SELECT id FROM message WHERE account_id = $1 ORDER BY uid DESC LIMIT 1`, a.id).Scan(&id); err != nil {
			t.Fatal(err)
		}
		took = nil
		version = settle(a, version)
		seen := false
		for range runs {
			seen = !seen
			cmd, _ := json.Marshal(msg.MessageUpdate{AccountId: a.id, MessageId: id, Seen: &seen})
			start := time.Now()
			if _, err := js.Publish(ctx, "cmd.message.update", cmd); err != nil {
				t.Fatal(err)
			}
			version = await(a, version)
			took = append(took, time.Since(start))
			version = settle(a, version)
		}
		report("mark as read until saved", took)
	}
}

// appendMail puts a message in the user's INBOX, straight to the server, and returns when the server has it.
func appendMail(t *testing.T, server, user, subject string) time.Time {
	host, port, _ := net.SplitHostPort(server)
	p, _ := strconv.Atoi(port)
	c, err := mail.DialIMAP(host, p, user, "hunter2", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = c.Logout().Wait() }()
	raw := fmt.Appendf(nil, "From: Lena <lena@example.com>\r\nSubject: %s\r\nMessage-ID: <%s@example.com>\r\n\r\nHi", subject, rand.Text())
	cmd := c.Append("INBOX", int64(len(raw)), nil)
	_, _ = cmd.Write(raw)
	if err := cmd.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := cmd.Wait(); err != nil {
		t.Fatal(err)
	}
	return time.Now()
}

// pushDelay is how long the server itself takes to tell an IDLE connection about new mail, the median of runs.
// It is part of "new mail until saved", and not up to the engine.
func pushDelay(t *testing.T, server string, runs int) time.Duration {
	user := strings.ToLower(rand.Text())
	appendMail(t, server, user, "First")
	host, port, _ := net.SplitHostPort(server)
	p, _ := strconv.Atoi(port)
	news := make(chan time.Time, 10)
	c, err := mail.DialIMAP(host, p, user, "hunter2", &imapclient.UnilateralDataHandler{
		Mailbox: func(d *imapclient.UnilateralDataMailbox) {
			if d.NumMessages != nil {
				news <- time.Now()
			}
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = c.Close() }()
	if _, err := c.Select("INBOX", nil).Wait(); err != nil {
		t.Fatal(err)
	}
	idle, err := c.Idle()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = idle.Close() }()
	var took []time.Duration
	for i := range runs {
		start := appendMail(t, server, user, fmt.Sprint("Mail ", i))
		select {
		case at := <-news:
			took = append(took, at.Sub(start))
		case <-time.After(30 * time.Second):
			t.Fatal("no IDLE notification")
		}
	}
	slices.Sort(took)
	return took[len(took)/2]
}
