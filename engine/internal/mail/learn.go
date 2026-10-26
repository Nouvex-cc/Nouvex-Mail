// SPDX-License-Identifier: AGPL-3.0-only

package mail

import (
	"context"
	"encoding/json"
	"log/slog"
	"slices"

	"github.com/emersion/go-imap/v2"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/db"
	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/secret"
)

// How much of a user's mail learning reads again: the newest of the inbox and the junk folder, and of each message
// its start, enough for the headers and how the text begins.
const (
	learnInbox = 2000
	learnJunk  = 300
	learnBytes = 16 << 10
)

// read is a message as learning sees it: where it is, what the rules say, and what it's known to be, if anything.
type read struct {
	boxID    string
	inbox    bool
	uid      int64
	sample   Sample
	category string
	spam     bool
	pinned   bool
	label    int // -1: not known
}

// Learn trains the user's sorting model on their own mail, then sorts their inboxes again with it. What's stored is
// sealed to the user, so the mail is read once more from their providers, and only the model is kept, sealed.
// Known is what the user said about a sender, mail from people they wrote to or answered, what the rules are sure
// of, and the junk folder; the rest only gets sorted.
func Learn(ctx context.Context, pool *pgxpool.Pool, master []byte, userID string) error {
	seed, err := Sorting.Seed(ctx)
	if err != nil {
		return err
	}
	q := db.New(pool)
	ids, err := q.ListUserAccountIDs(ctx, userID)
	if err != nil {
		return err
	}
	inboxes := map[string][]read{}
	var known []read
	for _, id := range ids {
		got, err := readAccount(ctx, q, master, id)
		if err != nil {
			slog.Warn("learn: read", "account", id, "err", err)
			continue
		}
		for _, m := range got {
			if m.label >= 0 {
				known = append(known, m)
			}
		}
		inboxes[id] = got
	}
	samples := make([]Sample, len(known))
	for i, m := range known {
		samples[i] = m.sample
	}
	vectors, err := Sorting.vectors(ctx, samples)
	if err != nil {
		return err
	}
	var train, held []Example
	for i, m := range known {
		e := Example{X: vectors[i], Label: m.label}
		if i%5 == 4 {
			held = append(held, e)
		} else {
			train = append(train, e)
		}
	}
	// What a model trained without a fifth of the known mail gets right of that fifth.
	metrics := map[string]int{"known": len(known), "held": len(held)}
	check := Fit(slices.Concat(seed, train))
	for i, e := range held {
		m := known[i*5+4]
		category, spam := decide(check.Probs(e.X), m.category, m.spam, m.sample)
		got := slices.Index(Labels, category)
		if spam {
			got = spamLabel
		}
		if got == e.Label {
			metrics["right"]++
		}
		if spam && e.Label != spamLabel {
			metrics["falseSpam"]++
		}
	}
	h := Fit(slices.Concat(seed, train, held))
	raw, _ := json.Marshal(metrics)
	if err := q.SaveSortModel(ctx, db.SaveSortModelParams{UserID: userID, Weights: secret.Seal(master, h.Marshal()), Metrics: raw}); err != nil {
		return err
	}
	slog.Info("learned", "user", userID, "metrics", string(raw))

	for id, got := range inboxes {
		if err := resort(ctx, q, h, id, got); err != nil {
			slog.Warn("learn: sort", "account", id, "err", err)
		}
	}
	return nil
}

// readAccount reads the newest mail of an account's inbox and junk folder. On its own connection: a sync may be
// running meanwhile.
func readAccount(ctx context.Context, q *db.Queries, master []byte, accountID string) ([]read, error) {
	acc, err := q.GetAccount(ctx, accountID)
	if err != nil {
		return nil, err
	}
	pass, err := secret.Open(master, acc.Secret)
	if err != nil {
		return nil, err
	}
	c, err := DialIMAP(acc.ImapHost, int(acc.ImapPort), acc.Username, pass, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = c.Close() }()
	s := &syncer{ctx: ctx, q: q, acc: acc}
	if err := s.loadSorting(); err != nil {
		return nil, err
	}
	boxes, err := q.ListMailboxes(ctx, acc.ID)
	if err != nil {
		return nil, err
	}
	var out []read
	for _, b := range boxes {
		limit := map[string]int{"inbox": learnInbox, "junk": learnJunk}[b.Role]
		if limit == 0 || b.Local {
			continue
		}
		s.roles[b.ID] = b.Role
		if _, err := c.Select(b.Name, &imap.SelectOptions{ReadOnly: true}).Wait(); err != nil {
			return nil, err
		}
		found, err := c.UIDSearch(&imap.SearchCriteria{}, nil).Wait()
		if err != nil {
			return nil, err
		}
		uids := found.AllUIDs()
		uids = uids[max(0, len(uids)-limit):]
		start := &imap.FetchItemBodySection{Peek: true, Partial: &imap.SectionPartial{Size: learnBytes}}
		msgs, err := c.Fetch(imap.UIDSetNum(uids...), &imap.FetchOptions{
			UID: true, Envelope: true, Flags: true, BodySection: []*imap.FetchItemBodySection{start},
		}).Collect()
		if err != nil {
			return nil, err
		}
		for _, m := range msgs {
			p, err := Content(m.FindBodySection(start))
			if err != nil || m.Envelope == nil || len(m.Envelope.From) == 0 {
				continue
			}
			r := read{boxID: b.ID, inbox: b.Role == "inbox", uid: int64(m.UID), sample: p.Sample, label: -1}
			r.category, r.spam, r.pinned = s.sort(b.ID, m.Envelope.From[0].Addr(), p)
			switch {
			case b.Role == "junk":
				r.label = spamLabel
			case r.pinned && r.spam:
				r.label = spamLabel
			case r.pinned:
				r.label = slices.Index(Labels, r.category)
			case slices.Contains(m.Flags, imap.FlagAnswered):
				r.label = 0
			}
			out = append(out, r)
		}
	}
	return out, nil
}

// resort sorts an account's inbox again, with the rules as they are now and the model. It doesn't call mail spam
// that wasn't before: the user has seen it in their inbox already.
func resort(ctx context.Context, q *db.Queries, h *Head, accountID string, mail []read) error {
	mail = slices.DeleteFunc(mail, func(m read) bool { return !m.inbox })
	var open []Sample
	for _, m := range mail {
		if !m.pinned {
			open = append(open, m.sample)
		}
	}
	vectors, err := Sorting.vectors(ctx, open)
	if err != nil {
		return err
	}
	byBox := map[string][]read{}
	for _, m := range mail {
		if !m.pinned {
			m.category, m.spam = decide(h.Probs(vectors[0]), m.category, m.spam, m.sample)
			vectors = vectors[1:]
		}
		byBox[m.boxID] = append(byBox[m.boxID], m)
	}
	for boxID, box := range byBox {
		uids := make([]int64, len(box))
		for i, m := range box {
			uids[i] = m.uid
		}
		stored, err := q.ListSorted(ctx, db.ListSortedParams{MailboxID: boxID, Uids: uids})
		if err != nil {
			return err
		}
		rows := map[int64]db.ListSortedRow{}
		for _, r := range stored {
			rows[r.Uid] = r
		}
		for _, m := range box {
			r, ok := rows[m.uid]
			if !ok {
				continue
			}
			err := q.SortMessage(ctx, db.SortMessageParams{
				AccountID: accountID, ID: r.ID,
				Category: pgtype.Text{String: m.category, Valid: true},
				Spam:     pgtype.Bool{Bool: m.spam && r.Spam, Valid: true},
			})
			if err != nil {
				return err
			}
		}
	}
	return nil
}
