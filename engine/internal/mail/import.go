// SPDX-License-Identifier: AGPL-3.0-only

package mail

import (
	"context"
	"encoding/json"
	"slices"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapclient"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/db"
	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/secret"
)

// importBatch is how many messages one step of an import moves. The mailbox's other commands, like mail our MX
// takes for it, run between steps.
var importBatch = 100

// importFolder is one source folder of an import and where it goes (apps/api/src/db/schema.ts, ImportFolder).
type importFolder struct {
	From string `json:"from"`
	Role string `json:"role"`
	Name string `json:"name"`
}

// ImportStep moves the next messages of an import from its source account's IMAP server into its hosted mailbox,
// read-only on the source. Where it got to is saved with the messages, so a step that fails is just tried again,
// and a message already in its folder (same Message-ID) isn't stored twice. It returns the mailbox's version and
// whether there's more.
func ImportStep(ctx context.Context, pool *pgxpool.Pool, store Store, master []byte, jobID string) (int64, bool, error) {
	q := db.New(pool)
	job, err := q.GetImportJob(ctx, jobID)
	if err != nil || job.FinishedAt.Valid {
		return 0, false, err
	}
	var folders []importFolder
	if err := json.Unmarshal(job.Folders, &folders); err != nil {
		return 0, false, err
	}
	src, err := q.GetAccount(ctx, job.SourceID)
	if err != nil {
		return 0, false, err
	}
	pass, err := secret.Open(master, src.Secret)
	if err != nil {
		return 0, false, err
	}
	c, err := DialIMAP(src.ImapHost, int(src.ImapPort), src.Username, pass, nil)
	if err != nil {
		return 0, false, err
	}
	defer func() { _ = c.Logout().Wait(); _ = c.Close() }()

	if !job.Total.Valid {
		total := 0
		for _, f := range folders {
			st, err := c.Status(f.From, &imap.StatusOptions{NumMessages: true}).Wait()
			if err != nil {
				return 0, false, err
			}
			total += int(*st.NumMessages)
		}
		if err := q.SetImportTotal(ctx, db.SetImportTotalParams{ID: job.ID, Total: pgtype.Int4{Int32: int32(total), Valid: true}}); err != nil {
			return 0, false, err
		}
	}

	acc, err := q.GetAccount(ctx, job.AccountID)
	if err != nil {
		return 0, false, err
	}
	pub, err := q.GetUserKey(ctx, acc.ID)
	if err != nil {
		return 0, false, err
	}
	s := &syncer{ctx: ctx, pool: pool, store: store, progress: func(int64, []string) {}, acc: acc, pub: pub}
	if err := s.begin(); err != nil {
		return 0, false, err
	}
	defer func() { _ = s.tx.Rollback(ctx) }()

	// One batch from the folder it's at; folders with nothing left are passed over.
	for int(job.Folder) < len(folders) {
		f := folders[job.Folder]
		if _, err := c.Select(f.From, &imap.SelectOptions{ReadOnly: true}).Wait(); err != nil {
			return 0, false, err
		}
		found, err := c.UIDSearch(&imap.SearchCriteria{
			UID: []imap.UIDSet{{imap.UIDRange{Start: imap.UID(job.AfterUid + 1), Stop: 0}}},
		}, nil).Wait()
		if err != nil {
			return 0, false, err
		}
		// "n:*" also names the last message when its UID is below n.
		uids := slices.DeleteFunc(found.AllUIDs(), func(u imap.UID) bool { return int64(u) <= job.AfterUid })
		slices.Sort(uids)
		if len(uids) == 0 {
			job.Folder, job.AfterUid = job.Folder+1, 0
			continue
		}
		uids = uids[:min(len(uids), importBatch)]
		msgs, err := c.Fetch(imap.UIDSetNum(uids...), &imap.FetchOptions{
			UID: true, Flags: true, BodySection: []*imap.FetchItemBodySection{whole},
		}).Collect()
		if err != nil {
			return 0, false, err
		}
		slices.SortFunc(msgs, func(a, b *imapclient.FetchMessageBuffer) int { return int(a.UID) - int(b.UID) })
		box, err := s.localBox(f.Role, f.Name)
		if err != nil {
			return 0, false, err
		}
		for _, m := range msgs {
			if raw := m.FindBodySection(whole); raw != nil {
				// Sorted into tabs and checked for spam like new mail when it goes to the inbox.
				if _, _, err := s.ingest(box, raw, arrival{flags: flagStrings(m.Flags), sorted: f.Role == "inbox"}); err != nil {
					return 0, false, err
				}
			}
		}
		job.AfterUid = int64(uids[len(uids)-1])
		job.Done += int32(len(uids))
		break
	}
	more := int(job.Folder) < len(folders)
	if err := s.q.SetImportProgress(ctx, db.SetImportProgressParams{
		ID: job.ID, Folder: job.Folder, AfterUid: job.AfterUid, Done: job.Done, Finished: !more,
	}); err != nil {
		return 0, false, err
	}
	if err := s.flush(); err != nil {
		return 0, false, err
	}
	return s.acc.Version, more, s.tx.Commit(ctx)
}
