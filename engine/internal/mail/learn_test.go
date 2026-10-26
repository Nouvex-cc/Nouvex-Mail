// SPDX-License-Identifier: AGPL-3.0-only

package mail

import (
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/emersion/go-imap/v2"

	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/db"
	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/secret"
)

// TestLearn trains a user's model from their mailbox on a real server and embed service, and sorts their inbox again.
func TestLearn(t *testing.T) {
	e := benchEnv(t)
	if os.Getenv("EMBED_URL") == "" {
		t.Skip("EMBED_URL not set")
	}
	u := e.mailbox(t, map[string]int{"INBOX": 0, "Junk": 0})
	for i := range 6 {
		u.append(t, "INBOX", reply(fmt.Sprint("answered-", i), fmt.Sprint("before-", i)))
		u.append(t, "Junk", fmt.Appendf(nil, "From: Account Team <support@mailbox-verify-%d.top>\r\nSubject: Your mailbox will be deactivated\r\n"+
			"Content-Type: text/plain\r\n\r\nYour account has exceeded its storage limit. Click here to verify your account within 24 hours.", i))
	}
	if _, err := u.c.Select("INBOX", nil).Wait(); err != nil {
		t.Fatal(err)
	}
	var all imap.UIDSet
	all.AddRange(1, 0)
	if err := u.c.Store(all, &imap.StoreFlags{Op: imap.StoreFlagsAdd, Flags: []imap.Flag{imap.FlagAnswered}}, nil).Close(); err != nil {
		t.Fatal(err)
	}
	github := "From: GitHub <notifications@github.com>\r\nSubject: Re: [acme/shop] Search returns nothing for umlauts (Issue #318)\r\n" +
		"Authentication-Results: mx.example.net; dkim=pass header.d=github.com; spf=pass smtp.mailfrom=github.com; dmarc=pass\r\n" +
		"List-Id: acme/shop <shop.acme.github.com>\r\nList-Unsubscribe: <mailto:unsub@reply.github.com>\r\nPrecedence: list\r\n" +
		"Content-Type: text/plain\r\n\r\njan-k commented on this issue. I can reproduce it on main. You are receiving this because you were mentioned."
	u.append(t, "INBOX", []byte(github))
	phish := "From: PayPal <service@paypal-konto-check.top>\r\nSubject: Ihr Konto wurde eingeschränkt\r\nContent-Type: text/plain\r\n\r\n" +
		"Bitte bestätigen Sie Ihre Daten innerhalb von 24 Stunden, sonst wird Ihr Konto gesperrt."
	u.append(t, "INBOX", []byte(phish))
	// Longer than what learning reads of a message: the text comes first, the cut falls into the HTML.
	long := "From: Lena Hartmann <lena@example.com>\r\nSubject: Fotos vom Wochenende\r\nMIME-Version: 1.0\r\n" +
		"Content-Type: multipart/alternative; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nHier die Fotos vom Wochenende.\r\n" +
		"--b\r\nContent-Type: text/html\r\n\r\n<p>" + strings.Repeat("Hier die Fotos vom Wochenende. ", 1500) + "</p>\r\n--b--\r\n"
	u.append(t, "INBOX", []byte(long))

	id := e.account(t, u, e.imap)
	e.syncWithin(t, id, "first sync")
	var userID string
	if err := e.pool.QueryRow(e.ctx, `SELECT user_id FROM mail_account WHERE id = $1`, id).Scan(&userID); err != nil {
		t.Fatal(err)
	}
	// As the rules had it before they read every Authentication-Results header.
	if _, err := e.pool.Exec(e.ctx, `UPDATE message m SET spam = true FROM mailbox b WHERE m.mailbox_id = b.id AND b.account_id = $1 AND b.role = 'inbox' AND m.uid = 7`, id); err != nil {
		t.Fatal(err)
	}
	var before int64
	_ = e.pool.QueryRow(e.ctx, `SELECT version FROM mail_account WHERE id = $1`, id).Scan(&before)

	Sorting = NewSorter(os.Getenv("EMBED_URL"))
	t.Cleanup(func() { Sorting = nil })
	read, err := readAccount(e.ctx, db.New(e.pool), e.master, id)
	if err != nil {
		t.Fatal(err)
	}
	var known, cut int
	for _, m := range read {
		if m.label >= 0 {
			known++
		}
		if strings.Contains(m.sample.Text, "Fotos vom Wochenende. Hier die Fotos") {
			cut++
		}
	}
	if len(read) != 15 || known < 12 || cut != 1 {
		t.Fatalf("read %d, %d known, %d cut short", len(read), known, cut)
	}
	if err := Learn(e.ctx, e.pool, e.master, userID); err != nil {
		t.Fatal(err)
	}

	var weights []byte
	var metrics string
	if err := e.pool.QueryRow(e.ctx, `SELECT weights, metrics FROM sort_model WHERE user_id = $1`, userID).Scan(&weights, &metrics); err != nil {
		t.Fatal(err)
	}
	raw, err := secret.Open(e.master, weights)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := UnmarshalHead([]byte(raw)); err != nil {
		t.Fatal(err)
	}
	t.Log(metrics)
	spam := func(uid int) (s bool) {
		err := e.pool.QueryRow(e.ctx, `SELECT m.spam FROM message m JOIN mailbox b ON b.id = m.mailbox_id WHERE b.account_id = $1 AND b.role = 'inbox' AND m.uid = $2`, id, uid).Scan(&s)
		if err != nil {
			t.Fatal(err)
		}
		return s
	}
	if spam(7) {
		t.Error("the signed GitHub notification is still spam")
	}
	if spam(8) {
		t.Error("mail in the inbox that wasn't spam became spam")
	}
	var after int64
	_ = e.pool.QueryRow(e.ctx, `SELECT version FROM mail_account WHERE id = $1`, id).Scan(&after)
	if after == before {
		t.Error("sorting again logged no change")
	}

	// New mail is sorted with the user's model from now on.
	u.append(t, "INBOX", []byte(github))
	e.syncWithin(t, id, "sync with the model")
	if _, ok := Sorting.heads[userID]; !ok {
		t.Error("the sync didn't sort with the user's model")
	}
	if spam(10) {
		t.Error("the model made a signed notification spam")
	}
}
