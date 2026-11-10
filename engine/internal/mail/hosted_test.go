// SPDX-License-Identifier: AGPL-3.0-only

package mail

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"errors"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/db"
	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/msg"
	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/secret"
)

// A hosted account keeps its mail in local folders sealed to its own key: it moves, drafts and sends without a
// server, and a reset of its owner's key loses nothing.
func TestHosted(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	master := bytes.Repeat([]byte{7}, 32)
	var mu sync.Mutex
	stored := map[string]bool{}
	store := Store{Put: func(_ context.Context, key string, _ []byte, _ string) error {
		mu.Lock()
		defer mu.Unlock()
		stored[key] = true
		return nil
	}, Drop: noDrop}
	KeepHostedIn(f.pool, store)

	// The account's own key, not its owner's.
	accKey, _ := ecdh.X25519().GenerateKey(rand.Reader)
	if _, err := f.pool.Exec(ctx, `UPDATE mail_account SET kind = 'hosted', imap_host = '', smtp_host = '', sealed_to = $2 WHERE id = $1`,
		f.id, accKey.PublicKey().Bytes()); err != nil {
		t.Fatal(err)
	}
	f.key = accKey
	if _, err := Sync(ctx, f.pool, store, master, f.id, func(int64, []string) {}); err != nil {
		t.Fatal(err)
	}
	var roles []string
	_ = f.pool.QueryRow(ctx, `SELECT array_agg(role ORDER BY role) FROM mailbox WHERE account_id = $1 AND local`, f.id).Scan(&roles)
	if !slices.Equal(roles, []string{"archive", "drafts", "inbox", "junk", "sent", "snoozed", "trash"}) {
		t.Fatalf("folders %v", roles)
	}

	raw := []byte("From: Max <max@friend.org>\r\nTo: lena@example.com\r\nSubject: Dinner\r\nMessage-ID: <dinner@friend.org>\r\n\r\nTomorrow?")
	if _, _, err := Seed(ctx, f.pool, store, f.id, raw); err != nil {
		t.Fatal(err)
	}
	m := f.find(t, "Dinner")
	if m.Role != "inbox" || !stored["eml/"+m.ID] {
		t.Fatalf("%+v, whole message kept: %v", m, stored["eml/"+m.ID])
	}

	q := db.New(f.pool)
	yes := true
	until := time.Now().Add(time.Hour)
	for _, step := range []struct {
		cmd  msg.MessageUpdate
		want string
	}{
		{msg.MessageUpdate{Archive: &yes}, "archive"},
		{msg.MessageUpdate{Inbox: &yes}, "inbox"},
		{msg.MessageUpdate{SnoozeUntil: &until}, "snoozed"},
		{msg.MessageUpdate{Spam: &yes}, "junk"},
		{msg.MessageUpdate{Trash: &yes}, "trash"},
		{msg.MessageUpdate{Trash: &yes}, ""},
	} {
		step.cmd.AccountId, step.cmd.MessageId = f.id, m.ID
		if err := Update(ctx, q, master, step.cmd); err != nil {
			t.Fatal(err)
		}
		if got := f.find(t, "Dinner").Role; got != step.want {
			t.Fatalf("after %+v in %q, want %q", step.cmd, got, step.want)
		}
	}
	var jobs int
	_ = f.pool.QueryRow(ctx, `SELECT count(*) FROM scheduled WHERE account_id = $1 AND kind = 'unsnooze'`, f.id).Scan(&jobs)
	if jobs != 1 {
		t.Fatalf("%d unsnooze jobs", jobs)
	}

	// Each save replaces the last version; a discard leaves nothing.
	for _, text := range []string{"First", "Second"} {
		if err := SaveDraft(ctx, q, nil, master, msg.DraftSave{AccountId: f.id, DraftId: "d1", To: []string{"max@friend.org"}, Subject: "Plan", Text: text}, ""); err != nil {
			t.Fatal(err)
		}
	}
	var drafts []opened
	for _, m := range f.messages(t) {
		if m.Role == "drafts" {
			drafts = append(drafts, m)
		}
	}
	if len(drafts) != 1 || !strings.Contains(drafts[0].Snippet, "Second") {
		t.Fatalf("drafts %+v", drafts)
	}
	if err := DiscardDraft(ctx, q, master, f.id, "d1"); err != nil {
		t.Fatal(err)
	}
	if f.find(t, "Plan").ID != "" {
		t.Fatal("discarded draft still there")
	}

	sent := []byte("From: lena@example.com\r\nTo: max@friend.org\r\nSubject: Sent one\r\nMessage-ID: <s1@example.com>\r\n\r\nHi")
	if err := SaveSent(ctx, q, master, f.id, sent); err != nil {
		t.Fatal(err)
	}
	if got := f.find(t, "Sent one"); got.Role != "sent" {
		t.Fatalf("%+v", got)
	}

	// The owner's key changes (a password reset): the account's own key still opens everything.
	other, _ := ecdh.X25519().GenerateKey(rand.Reader)
	if _, err := f.pool.Exec(ctx, `UPDATE user_key SET public_key = $2 WHERE user_id = $1`, f.id, other.PublicKey().Bytes()); err != nil {
		t.Fatal(err)
	}
	if _, err := Sync(ctx, f.pool, store, master, f.id, func(int64, []string) {}); err != nil {
		t.Fatal(err)
	}
	if got := f.find(t, "Sent one"); got.ID == "" {
		t.Fatal("hosted mail gone after the owner's key changed")
	}
}

// What our MX spooled ends up sealed in the hosted inbox: once, however often it's delivered, and as spam when rspamd
// said so.
func TestReceive(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	master := bytes.Repeat([]byte{7}, 32)
	store := Store{Put: func(context.Context, string, []byte, string) error { return nil }, Drop: noDrop}
	accKey, _ := ecdh.X25519().GenerateKey(rand.Reader)
	if _, err := f.pool.Exec(ctx, `UPDATE mail_account SET kind = 'hosted', sealed_to = $2 WHERE id = $1`, f.id, accKey.PublicKey().Bytes()); err != nil {
		t.Fatal(err)
	}
	f.key = accKey
	spool := map[string][]byte{
		"in/1/a": secret.Seal(master, []byte("From: Max <max@friend.org>\r\nSubject: Dinner\r\nMessage-ID: <dinner@friend.org>\r\n\r\nFriday?")),
		"in/2/a": secret.Seal(master, []byte("From: Win <win@prize.example>\r\nSubject: You won\r\nMessage-ID: <won@prize.example>\r\n\r\nClick")),
	}
	get := func(_ context.Context, key string) ([]byte, error) { return spool[key], nil }
	for i, key := range []string{"in/1/a", "in/1/a"} {
		_, arrived, err := Receive(ctx, f.pool, store, get, master, msg.MailDeliver{AccountId: f.id, SpoolKey: key})
		if err != nil || len(arrived) != 1-i {
			t.Fatalf("delivery %d: arrived %v, %v", i, arrived, err)
		}
	}
	if m := f.find(t, "Dinner"); m.Role != "inbox" || len(f.messages(t)) != 1 {
		t.Fatalf("%+v of %d", m, len(f.messages(t)))
	}
	if _, arrived, err := Receive(ctx, f.pool, store, get, master, msg.MailDeliver{AccountId: f.id, SpoolKey: "in/2/a", Spam: true}); err != nil || len(arrived) != 0 {
		t.Fatalf("spam arrived %v, %v", arrived, err)
	}
	var spam bool
	_ = f.pool.QueryRow(ctx, `SELECT spam FROM message WHERE id = $1`, f.find(t, "You won").ID).Scan(&spam)
	if !spam {
		t.Fatal("rspamd's spam isn't spam")
	}
}

// Our MX finds a mailbox by its own address or an alias, and else by its verified domain's catch-all.
func TestHostedLookup(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	q := db.New(f.pool)
	domain := strings.ToLower(rand.Text()) + ".test"
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := f.pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`UPDATE mail_account SET kind = 'hosted' WHERE id = $1`, f.id)
	exec(`INSERT INTO domain (id, user_id, name, verify_token, dkim_public, dkim_private) VALUES ($1, $2, $3, 't', 'p', '')`, domain, f.id, domain)
	exec(`INSERT INTO address (address, account_id, domain_id, kind) VALUES ($1, $3, $4, 'primary'), ($2, $3, $4, 'alias')`,
		"lena@"+domain, "team@"+domain, f.id, domain)
	find := func(address string) string {
		t.Helper()
		id, err := q.HostedAccount(ctx, address)
		if errors.Is(err, pgx.ErrNoRows) {
			return ""
		}
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	if find("lena@"+domain) != f.id || find("team@"+domain) != f.id || find("other@"+domain) != "" {
		t.Fatal("addresses")
	}
	// A catch-all counts only once the domain is verified.
	exec(`UPDATE domain SET catch_all_account_id = $2 WHERE id = $1`, domain, f.id)
	if find("other@"+domain) != "" {
		t.Fatal("catch-all of an unverified domain")
	}
	exec(`UPDATE domain SET verified_at = now() WHERE id = $1`, domain)
	if find("other@"+domain) != f.id {
		t.Fatal("catch-all")
	}
	// Archived means rarely used: it still receives.
	exec(`UPDATE domain SET catch_all_account_id = NULL WHERE id = $1`, domain)
	exec(`UPDATE mail_account SET archived_at = now() WHERE id = $1`, f.id)
	if find("lena@"+domain) != f.id {
		t.Fatal("archived mailbox refuses mail")
	}
}

// A hosted mailbox sends: to Nouvex mailboxes directly (and can take it back), to everyone else through Outward,
// from its own address or an alias, never from someone else's.
func TestHostedSend(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	master := bytes.Repeat([]byte{7}, 32)
	store := Store{Put: func(context.Context, string, []byte, string) error { return nil }, Drop: noDrop}
	KeepHostedIn(f.pool, store)
	q := db.New(f.pool)
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := f.pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	domain := strings.ToLower(rand.Text()) + ".test"
	senderKey, _ := ecdh.X25519().GenerateKey(rand.Reader)
	maxKey, _ := ecdh.X25519().GenerateKey(rand.Reader)
	exec(`UPDATE mail_account SET kind = 'hosted', email = $2, sealed_to = $3 WHERE id = $1`, f.id, "lena@"+domain, senderKey.PublicKey().Bytes())
	maxID := rand.Text()
	exec(`INSERT INTO mail_account (id, user_id, email, kind, imap_host, imap_port, smtp_host, smtp_port, username, secret, sealed_to)
		VALUES ($1, $2, $3, 'hosted', '', 0, '', 0, '', '', $4)`, maxID, f.id, "max@"+domain, maxKey.PublicKey().Bytes())
	exec(`INSERT INTO domain (id, user_id, name, verify_token, dkim_public, dkim_private, verified_at) VALUES ($1, $2, $1, 't', 'p', '', now())`, domain, f.id)
	exec(`INSERT INTO address (address, account_id, domain_id, kind) VALUES ($1, $2, $5, 'primary'), ($3, $2, $5, 'alias'), ($4, $6, $5, 'primary')`,
		"lena@"+domain, f.id, "team@"+domain, "max@"+domain, domain, maxID)
	for _, id := range []string{f.id, maxID} {
		if _, err := Sync(ctx, f.pool, store, master, id, func(int64, []string) {}); err != nil {
			t.Fatal(err)
		}
	}
	type out struct {
		from string
		to   []string
	}
	var outward []out
	Outward = func(_ context.Context, from string, to []string, _ []byte, tags map[string]string) error {
		if tags["account"] != f.id {
			t.Errorf("tags %v", tags)
		}
		outward = append(outward, out{from, to})
		return nil
	}
	t.Cleanup(func() { Outward = nil })
	send := func(draft string, from *string, to ...string) (Sent, error) {
		return Send(ctx, q, nil, master, msg.MessageSend{AccountId: f.id, DraftId: draft, To: to, Subject: "Plan " + draft, Text: "Hi", From: from}, "")
	}

	sent, err := send("d1", nil, "Max@"+domain, "anna@friend.example")
	if err != nil || !sent.Taken || len(sent.Inside) != 1 || sent.Inside[0].AccountID != maxID || len(sent.Inside[0].Arrived) != 1 {
		t.Fatalf("%+v %v", sent, err)
	}
	if len(outward) != 1 || outward[0].from != "lena@"+domain || !slices.Equal(outward[0].to, []string{"anna@friend.example"}) {
		t.Fatalf("outward %+v", outward)
	}
	// Max's mailbox holds only what Lena sends him here.
	maxHasMail := func() bool {
		var n int
		_ = f.pool.QueryRow(ctx, `SELECT count(*) FROM message WHERE account_id = $1`, maxID).Scan(&n)
		return n > 0
	}
	if !maxHasMail() {
		t.Fatal("not in Max's inbox")
	}

	alias, other := "Team@"+domain, "max@"+domain
	if _, err := send("d2", &alias, "anna@friend.example"); err != nil || outward[1].from != "team@"+domain {
		t.Fatalf("alias: %v %+v", err, outward)
	}
	if _, err := send("d3", &other, "anna@friend.example"); err == nil {
		t.Fatal("sent from someone else's address")
	}

	// Taken back out of Max's mailbox; only Nouvex copies can be.
	if gone, err := Unsend(ctx, q, store, f.id, SendID("d1", "lena@"+domain)); err != nil || len(gone) != 1 {
		t.Fatalf("unsend %+v %v", gone, err)
	}
	if maxHasMail() {
		t.Fatal("still in Max's inbox")
	}

	// Without SES nothing goes outside, and the user hears why; Nouvex recipients still get it.
	Outward = nil
	sent, err = send("d4", nil, "max@"+domain, "anna@friend.example")
	if sent.Taken || !errors.Is(err, errNotSetUp) || len(sent.Inside) != 1 {
		t.Fatalf("%+v %v", sent, err)
	}

	in, err := Notify(ctx, f.pool, store, f.id, Report("lena@"+domain, Feedback{Kind: "bounce", Subject: "Plan d1"}))
	if err != nil || len(in.Arrived) != 1 {
		t.Fatalf("%+v %v", in, err)
	}
	f.key = senderKey
	if m := f.find(t, "Couldn't deliver: Plan d1"); m.Role != "inbox" || m.FromAddr != "postmaster@nouvex.cc" {
		t.Fatalf("%+v", m)
	}
}
