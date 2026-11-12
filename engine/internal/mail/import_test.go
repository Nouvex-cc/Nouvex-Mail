// SPDX-License-Identifier: AGPL-3.0-only

package mail

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"fmt"
	"slices"
	"testing"

	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/db"
)

// Mail moves from an IMAP account into a hosted mailbox: into the folders it was mapped to, with its flags, in
// steps that each pick up where the last left off, and never twice.
func TestImport(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	master := bytes.Repeat([]byte{7}, 32)
	store := Store{Put: func(context.Context, string, []byte, string) error { return nil }, Drop: noDrop}
	f.add("One")
	f.addSeen("Two")
	f.add("Three")
	for i := range 2 {
		f.appendTo("Work/Clients", fmt.Sprintf("Subject: Client %d\r\nMessage-ID: <%s@example.com>\r\n\r\nHi", i, rand.Text()))
	}
	f.appendTo("Trash", "Subject: Old\r\nMessage-ID: <old@example.com>\r\n\r\nHi")

	hosted := rand.Text()
	key, _ := ecdh.X25519().GenerateKey(rand.Reader)
	if _, err := f.pool.Exec(ctx, `INSERT INTO mail_account (id, user_id, email, kind, imap_host, imap_port, smtp_host, smtp_port, username, secret, sealed_to)
		VALUES ($1, $2, $3, 'hosted', '', 0, '', 0, '', '', $4)`, hosted, f.id, "lena@"+hosted+".test", key.PublicKey().Bytes()); err != nil {
		t.Fatal(err)
	}
	if _, err := Sync(ctx, f.pool, store, master, hosted, func(int64, []string) {}); err != nil {
		t.Fatal(err)
	}

	importBatch = 2
	t.Cleanup(func() { importBatch = 100 })
	run := func() (steps int) {
		t.Helper()
		job := rand.Text()
		if _, err := f.pool.Exec(ctx, `INSERT INTO import_job (id, account_id, source_id, folders) VALUES ($1, $2, $3, $4)`, job, hosted, f.id,
			`[{"from":"INBOX","role":"inbox","name":""},{"from":"Work/Clients","role":"","name":"Clients"}]`); err != nil {
			t.Fatal(err)
		}
		for more := true; more; steps++ {
			var err error
			if _, more, err = ImportStep(ctx, f.pool, store, master, job); err != nil {
				t.Fatal(err)
			}
			if steps > 10 {
				t.Fatal("doesn't end")
			}
		}
		j, _ := db.New(f.pool).GetImportJob(ctx, job)
		if j.Done != 5 || j.Total.Int32 != 5 || !j.FinishedAt.Valid {
			t.Fatalf("job %+v", j)
		}
		return steps
	}
	// Three in the inbox and two in Clients, two at a time: 2, 1, 2, and the one that finds nothing left.
	if steps := run(); steps != 4 {
		t.Fatalf("%d steps", steps)
	}
	in := func(name string) (n int, seen int) {
		t.Helper()
		_ = f.pool.QueryRow(ctx, `SELECT count(*), count(*) FILTER (WHERE '\Seen' = ANY(flags)) FROM message m JOIN mailbox b ON b.id = m.mailbox_id
			WHERE m.account_id = $1 AND b.name = $2`, hosted, name).Scan(&n, &seen)
		return n, seen
	}
	if n, seen := in("Inbox"); n != 3 || seen != 1 {
		t.Fatalf("inbox %d, %d seen", n, seen)
	}
	if n, _ := in("Clients"); n != 2 {
		t.Fatalf("clients %d", n)
	}
	if n, _ := in("Trash"); n != 0 {
		t.Fatal("took a folder it wasn't asked to")
	}

	// The same import again adds nothing.
	run()
	var n int
	_ = f.pool.QueryRow(ctx, `SELECT count(*) FROM message WHERE account_id = $1`, hosted).Scan(&n)
	if n != 5 {
		t.Fatalf("%d messages after a second import", n)
	}
	var boxes []string
	rows, _ := f.pool.Query(ctx, `SELECT name FROM mailbox WHERE account_id = $1`, hosted)
	for rows.Next() {
		var name string
		_ = rows.Scan(&name)
		boxes = append(boxes, name)
	}
	if !slices.Contains(boxes, "Clients") || len(boxes) != len(hostedBoxes)+1 {
		t.Fatalf("folders %v", boxes)
	}
}
