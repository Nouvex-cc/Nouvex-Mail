// SPDX-License-Identifier: AGPL-3.0-only

package mail

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapclient"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/db"
	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/seal"
	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/secret"
)

// Put stores an object, e.g. in S3. It is called from several goroutines at once.
type Put func(ctx context.Context, key string, data []byte, contentType string) error

// Store keeps the parts of messages: Drop removes a message's body and attachments.
type Store struct {
	Put  Put
	Drop func(ctx context.Context, messageID string) error
}

// Meta is what only the user can read about a message, sealed into message.sealed. The clients read the same
// fields (packages/sdk, apps/apple).
type Meta struct {
	MessageID   string   `json:"messageId"`
	Subject     string   `json:"subject"`
	Snippet     string   `json:"snippet"`
	FromName    string   `json:"fromName"`
	FromAddr    string   `json:"fromAddr"`
	To          []string `json:"to"`
	Cc          []string `json:"cc"`
	Attachments []File   `json:"attachments"`
	Actions     []Action `json:"actions"`
	// It has a designed version, stored as rich/<id>.html.
	Rich bool `json:"rich,omitempty"`
	// Nouvex put it into the inbox itself (Seed), so its nx-actions may open places in the app.
	Seeded bool `json:"seeded,omitempty"`
	// Where answers go when it isn't the sender, like a mailing list or a support desk.
	ReplyTo string `json:"replyTo,omitempty"`
	// How to leave the list it came from, if it says.
	Unsubscribe *Unsubscribe `json:"unsubscribe,omitempty"`
}

// Hashed is how Message-IDs are stored: equal ones still match, for conversations, without keeping the header.
func Hashed(id string) string {
	if id == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(id))
	return hex.EncodeToString(sum[:])
}

// batch is how many new messages are fetched and saved together: a dropped connection costs one batch, not the
// whole first sync.
const batch = 50

// uploads is how many messages of a batch are parsed and put in the bucket at once.
const uploads = 32

// whole is the full message, fetched without setting \Seen.
var whole = &imap.FetchItemBodySection{Peek: true}

func newMailItems() *imap.FetchOptions {
	return &imap.FetchOptions{
		UID: true, Envelope: true, Flags: true, RFC822Size: true, InternalDate: true,
		BodySection: []*imap.FetchItemBodySection{whole},
	}
}

// Sync brings every folder of the account up to date and returns the account's version afterwards. Each new
// message is sealed to the user's public key: its Meta in the row, the part to show as body/<id>.html, attachments
// as att/<id>/<index>. Work is saved folder by folder and in batches of new messages; progress is called with the
// version after each save. Without a key nothing is fetched: the user hasn't set a password yet.
func Sync(ctx context.Context, pool *pgxpool.Pool, store Store, master []byte, accountID string, progress func(version int64, arrived []string)) (_ int64, err error) {
	acc, err := db.New(pool).GetAccount(ctx, accountID)
	if err != nil {
		return 0, err
	}
	pub, err := db.New(pool).GetUserKey(ctx, accountID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return 0, err
	}
	s := &syncer{ctx: ctx, pool: pool, store: store, progress: progress, acc: acc, pub: pub, master: master}
	if err := s.begin(); err != nil {
		return 0, err
	}
	defer func() { _ = s.tx.Rollback(ctx) }()
	// A new key (after a reset) can't open what was sealed to the old one: start over.
	if !bytes.Equal(acc.SealedTo, pub) {
		if err := s.restart(); err != nil {
			return 0, err
		}
	}
	if pub == nil {
		if err := s.flush(); err != nil {
			return 0, err
		}
		return s.acc.Version, s.tx.Commit(ctx)
	}

	pass, err := secret.Open(master, acc.Secret)
	if err != nil {
		return 0, err
	}
	c, err := connect(acc, pass, false)
	if err != nil {
		return 0, err
	}
	defer func() { release(acc, c, err) }()
	// Whatever hangs, the sync ends: closing the connection fails every command waiting on it. Each commit resets it.
	watch := func(c *imapclient.Client) *time.Timer { return time.AfterFunc(stall, func() { _ = c.Close() }) }
	s.watchdog = watch(c)
	defer func() { s.watchdog.Stop() }()
	boxes, err := folders(c)
	if err != nil {
		// Maybe the server dropped a kept connection; a sync after new mail shouldn't wait a minute for its retry.
		// Not if it went silent: then the watchdog closed it, and the retry waits.
		if !s.watchdog.Stop() {
			return 0, err
		}
		_ = c.Close()
		again, err := DialIMAP(acc.ImapHost, int(acc.ImapPort), acc.Username, pass, nil)
		if err != nil {
			return 0, err
		}
		c = again
		s.watchdog = watch(c)
		if boxes, err = folders(c); err != nil {
			return 0, err
		}
	}

	s.c = c
	if err := s.loadSorting(); err != nil {
		return 0, err
	}

	stored, err := s.q.ListMailboxes(ctx, acc.ID)
	if err != nil {
		return 0, err
	}
	known := map[string]*db.Mailbox{}
	for i := range stored {
		// A local mailbox (seeded mail) isn't on the server and stays as it is.
		if !stored[i].Local {
			known[stored[i].Name] = &stored[i]
		}
	}
	listed := map[string]bool{}
	// Sent first: who the user writes to tells mail from people apart in the folders after it.
	slices.SortStableFunc(boxes, func(a, b *imap.ListData) int {
		if (role(a) == "sent") == (role(b) == "sent") {
			return 0
		}
		if role(a) == "sent" {
			return -1
		}
		return 1
	})
	for _, b := range boxes {
		listed[b.Mailbox] = true
		if err := s.folder(b.Mailbox, role(b), b.Status, known[b.Mailbox]); err != nil {
			return 0, err
		}
	}

	for _, b := range stored {
		if listed[b.Name] || b.Local {
			continue
		}
		// Deleted or renamed on the server; a renamed one comes back as a new folder.
		if err := s.drop(b.ID); err != nil {
			return 0, err
		}
	}
	if err := s.flush(); err != nil {
		return 0, err
	}
	return s.acc.Version, s.tx.Commit(ctx)
}

// folders lists the folders to sync. With CONDSTORE they come with their status, so unchanged ones can be skipped:
// in the LIST itself where the server can, else in STATUS commands sent all at once.
func folders(c *imapclient.Client) ([]*imap.ListData, error) {
	caps := c.Caps()
	condstore := caps.Has(imap.CapCondStore)
	status := &imap.StatusOptions{NumMessages: true, UIDNext: true, UIDValidity: true, HighestModSeq: true}
	opts := &imap.ListOptions{ReturnSpecialUse: caps.Has(imap.CapSpecialUse)}
	if condstore && (caps.Has(imap.CapListStatus) || caps.Has(imap.CapIMAP4rev2)) {
		opts.ReturnStatus = status
	}
	all, err := c.List("", "*", opts).Collect()
	if err != nil {
		return nil, err
	}
	boxes := skipVirtual(all)
	if condstore && opts.ReturnStatus == nil {
		cmds := make([]*imapclient.StatusCommand, len(boxes))
		for i, b := range boxes {
			cmds[i] = c.Status(b.Mailbox, status)
		}
		// A folder without status is synced the long way.
		for i, cmd := range cmds {
			if d, err := cmd.Wait(); err == nil {
				boxes[i].Status = d
			}
		}
	}
	return boxes, nil
}

type syncer struct {
	ctx      context.Context
	pool     *pgxpool.Pool
	tx       pgx.Tx
	q        *db.Queries
	c        *imapclient.Client
	store    Store
	progress func(version int64, arrived []string)
	// New inbox mail saved since the last commit, see MessageArrived.
	arrived []string
	acc     db.MailAccount
	pub     []byte
	master  []byte
	changes db.LogChangesParams
	// What sorts new mail: the user's own rules by sender hash, the people they wrote to, and each folder's role.
	rules    map[string]db.ListSenderRulesRow
	contacts map[string]bool
	roles    map[string]string
	watchdog *time.Timer
}

// stall is how long a sync may go without saving anything before its connection is closed. A batch of big
// messages over a slow line takes a few minutes at most.
var stall = 10 * time.Minute

func (s *syncer) begin() (err error) {
	s.tx, err = s.pool.Begin(s.ctx)
	s.q = db.New(s.tx)
	return err
}

// commit saves what is done so far, so a dropped connection later doesn't lose it, and reports the new version.
func (s *syncer) commit() error {
	if err := s.flush(); err != nil {
		return err
	}
	if err := s.tx.Commit(s.ctx); err != nil {
		return err
	}
	s.progress(s.acc.Version, s.arrived)
	s.arrived = nil
	s.watchdog.Reset(stall)
	return s.begin()
}

// log notes a change; flush writes the noted ones to the change log in one go.
func (s *syncer) log(entity, id, op string) {
	s.changes.Entities = append(s.changes.Entities, entity)
	s.changes.EntityIds = append(s.changes.EntityIds, id)
	s.changes.Ops = append(s.changes.Ops, op)
}

func (s *syncer) flush() (err error) {
	if len(s.changes.EntityIds) == 0 {
		return nil
	}
	s.changes.AccountID = s.acc.ID
	s.acc.Version, err = s.q.LogChanges(s.ctx, s.changes)
	s.changes = db.LogChangesParams{}
	return err
}

// clear drops every message of a folder.
func (s *syncer) clear(boxID string) error {
	gone, err := s.q.ClearMailbox(s.ctx, boxID)
	if err != nil {
		return err
	}
	return s.forget(gone)
}

// forget logs deleted messages and removes their parts.
func (s *syncer) forget(ids []string) error {
	for _, id := range ids {
		s.log("message", id, "delete")
		if err := s.store.Drop(s.ctx, id); err != nil {
			return err
		}
	}
	return nil
}

// drop removes a folder with its messages.
func (s *syncer) drop(boxID string) error {
	if err := s.clear(boxID); err != nil {
		return err
	}
	if err := s.q.DeleteMailbox(s.ctx, boxID); err != nil {
		return err
	}
	s.log("mailbox", boxID, "delete")
	return nil
}

// restart drops everything stored for the account, sealed to a key that is gone, and notes the current one.
func (s *syncer) restart() error {
	stored, err := s.q.ListMailboxes(s.ctx, s.acc.ID)
	if err != nil {
		return err
	}
	for _, b := range stored {
		if err := s.drop(b.ID); err != nil {
			return err
		}
	}
	return s.q.SetSealedTo(s.ctx, db.SetSealedToParams{ID: s.acc.ID, SealedTo: s.pub})
}

// folder syncs one folder. st is its status from the LIST, box what we stored for it; either may be nil.
//
// With CONDSTORE, a folder whose UIDNEXT, message count and HIGHESTMODSEQ didn't move is skipped, only flags that
// changed since the last sync are fetched, and the UIDs are only listed when messages are gone. The commands are
// sent together, so a folder with new mail costs one round trip to the server. Without CONDSTORE every UID's flags
// are compared.
func (s *syncer) folder(name, role string, st *imap.StatusData, box *db.Mailbox) error {
	ctx := s.ctx
	backfill := role == "sent" && len(s.contacts) == 0
	if box != nil && st != nil && st.NumMessages != nil && box.HighestModSeq > 0 && box.Role == role &&
		box.UidValidity == int64(st.UIDValidity) && box.UidNext == int64(st.UIDNext) &&
		box.MessageCount == int64(*st.NumMessages) && uint64(box.HighestModSeq) == st.HighestModSeq && !backfill {
		return nil
	}
	var last int64
	if box != nil {
		var err error
		if last, err = s.q.MaxUID(ctx, box.ID); err != nil {
			return err
		}
	}

	// What the status already tells is asked right along with the SELECT.
	condstore := s.c.Caps().Has(imap.CapCondStore)
	selCmd := s.c.Select(name, &imap.SelectOptions{ReadOnly: true, CondStore: condstore})
	same := box != nil && st != nil && st.NumMessages != nil && *st.NumMessages > 0 && box.UidValidity == int64(st.UIDValidity)
	var newCmd, flagCmd *imapclient.FetchCommand
	if same && int64(st.UIDNext) > last+1 && int64(st.UIDNext)-last-1 <= batch {
		// Up to UIDNEXT, not *: * is the newest message there is, one we have if the new ones are gone again, and
		// go-imap would hand it to the flags FETCH below, which nobody reads yet, and wait forever.
		var uids imap.UIDSet
		uids.AddRange(imap.UID(last+1), st.UIDNext-1)
		newCmd = s.c.Fetch(uids, newMailItems())
	}
	if same && box.HighestModSeq > 0 && last > 0 && st.HighestModSeq > uint64(box.HighestModSeq) {
		flagCmd = s.c.Fetch(upTo(last), &imap.FetchOptions{UID: true, Flags: true, ChangedSince: uint64(box.HighestModSeq)})
	}
	sel, err := selCmd.Wait()
	if err != nil {
		return err
	}
	var fresh, changed []*imapclient.FetchMessageBuffer
	if newCmd != nil {
		if fresh, err = newCmd.Collect(); err != nil {
			return err
		}
	}
	if flagCmd != nil {
		if changed, err = flagCmd.Collect(); err != nil {
			return err
		}
	}

	switch {
	case box == nil:
		box = &db.Mailbox{ID: rand.Text(), AccountID: s.acc.ID, Name: name, Role: role, UidValidity: int64(sel.UIDValidity)}
		if err := s.q.CreateMailbox(ctx, db.CreateMailboxParams{ID: box.ID, AccountID: box.AccountID, Name: name, Role: role, UidValidity: box.UidValidity}); err != nil {
			return err
		}
		s.log("mailbox", box.ID, "upsert")
	case box.UidValidity != int64(sel.UIDValidity) || box.Role != role:
		// A new UIDVALIDITY means the server renumbered the folder, so every UID we stored is meaningless now.
		// Clients drop the old rows and get everything again with new ids.
		if box.UidValidity != int64(sel.UIDValidity) {
			if err := s.clear(box.ID); err != nil {
				return err
			}
			last, fresh, changed, newCmd = 0, nil, nil, nil
			box.HighestModSeq = 0
		}
		if err := s.q.UpdateMailbox(ctx, db.UpdateMailboxParams{ID: box.ID, Role: role, UidValidity: int64(sel.UIDValidity)}); err != nil {
			return err
		}
		s.log("mailbox", box.ID, "upsert")
	}

	s.roles[box.ID] = role
	if newCmd != nil {
		if err := s.save(box.ID, last, fresh); err != nil {
			return err
		}
	} else if sel.NumMessages > 0 && (sel.UIDNext == 0 || int64(sel.UIDNext) > last+1) {
		if err := s.fetchNew(box.ID, last); err != nil {
			return err
		}
	}

	if box.HighestModSeq > 0 && sel.HighestModSeq > 0 {
		if flagCmd == nil && last > 0 && sel.NumMessages > 0 && sel.HighestModSeq != uint64(box.HighestModSeq) {
			if changed, err = s.c.Fetch(upTo(last), &imap.FetchOptions{UID: true, Flags: true, ChangedSince: uint64(box.HighestModSeq)}).Collect(); err != nil {
				return err
			}
		}
		if err := s.changedFlags(box.ID, changed); err != nil {
			return err
		}
		if err := s.gone(box.ID, sel.NumMessages); err != nil {
			return err
		}
	} else if err := s.allFlags(box.ID, sel.NumMessages); err != nil {
		return err
	}

	// Mail sent before Nouvex learned whom the user writes to: those addresses come once, from the envelopes alone.
	if backfill && len(s.contacts) == 0 && sel.NumMessages > 0 {
		var all imap.SeqSet
		all.AddRange(1, 0)
		sent, err := s.c.Fetch(all, &imap.FetchOptions{Envelope: true}).Collect()
		if err != nil {
			return err
		}
		if err := s.wroteTo(sent); err != nil {
			return err
		}
	}

	if box.UidNext != int64(sel.UIDNext) || box.MessageCount != int64(sel.NumMessages) || box.HighestModSeq != int64(sel.HighestModSeq) {
		if err := s.q.SetFolderState(ctx, db.SetFolderStateParams{
			ID: box.ID, UidNext: int64(sel.UIDNext), MessageCount: int64(sel.NumMessages), HighestModSeq: int64(sel.HighestModSeq),
		}); err != nil {
			return err
		}
	}
	return s.commit()
}

// after is every UID above last, upTo every UID up to it.
func after(last int64) imap.UIDSet {
	var uids imap.UIDSet
	uids.AddRange(imap.UID(last+1), 0)
	return uids
}

func upTo(last int64) imap.UIDSet {
	var uids imap.UIDSet
	uids.AddRange(1, imap.UID(last))
	return uids
}

// fetchNew lists the UIDs above last and saves their messages batch by batch, fetching the next batch while the
// current one is saved.
func (s *syncer) fetchNew(boxID string, last int64) error {
	found, err := s.c.Fetch(after(last), &imap.FetchOptions{UID: true}).Collect()
	if err != nil {
		return err
	}
	var fresh []imap.UID
	for _, m := range found {
		if int64(m.UID) > last {
			fresh = append(fresh, m.UID)
		}
	}
	type fetched struct {
		msgs []*imapclient.FetchMessageBuffer
		err  error
	}
	fetch := func(uids []imap.UID) chan fetched {
		ch := make(chan fetched, 1)
		go func() {
			msgs, err := s.c.Fetch(imap.UIDSetNum(uids...), newMailItems()).Collect()
			ch <- fetched{msgs, err}
		}()
		return ch
	}
	batches := slices.Collect(slices.Chunk(fresh, batch))
	var next chan fetched
	for i, b := range batches {
		if i == 0 {
			next = fetch(b)
		}
		r := <-next
		if r.err != nil {
			return r.err
		}
		if i+1 < len(batches) {
			next = fetch(batches[i+1])
		}
		if err := s.save(boxID, last, r.msgs); err != nil {
			return err
		}
	}
	return nil
}

// save stores the fetched messages above last and commits them. Parsing and uploads run in parallel, the rows go
// in one by one, since a message can join the conversation of the one before.
func (s *syncer) save(boxID string, last int64, msgs []*imapclient.FetchMessageBuffer) error {
	ready := make([]*prepared, len(msgs))
	errs := make([]error, len(msgs))
	var wg sync.WaitGroup
	limit := make(chan struct{}, uploads)
	for i, m := range msgs {
		if int64(m.UID) <= last || m.Envelope == nil {
			continue
		}
		wg.Go(func() {
			limit <- struct{}{}
			defer func() { <-limit }()
			ready[i], errs[i] = s.prepare(boxID, m)
		})
	}
	wg.Wait()
	if err := errors.Join(errs...); err != nil {
		return err
	}
	if s.roles[boxID] == "sent" {
		if err := s.wroteTo(msgs); err != nil {
			return err
		}
	}
	s.model(ready)
	// A folder's first sync brings old mail, none of it new.
	// ponytail: the first mail into an empty inbox isn't announced either.
	loud := last > 0 && s.roles[boxID] == "inbox"
	for _, p := range ready {
		if p == nil {
			continue
		}
		row := p.row
		added, err := s.insert(row)
		if err != nil {
			return err
		}
		if added && loud && !row.Spam && !slices.Contains(row.Flags, string(imap.FlagSeen)) {
			s.arrived = append(s.arrived, row.ID)
		}
	}
	return s.commit()
}

// insert puts a prepared message into its conversation and stores its row; false if it was there already.
func (s *syncer) insert(row *db.InsertMessageParams) (bool, error) {
	var err error
	if row.ThreadID, err = thread(s.ctx, s.q, s.acc.ID, row.MessageID, row.Refs, func(id string) error {
		s.log("message", id, "upsert")
		return nil
	}); err != nil {
		return false, err
	}
	if n, err := s.q.InsertMessage(s.ctx, *row); err != nil || n == 0 {
		return false, err
	}
	s.log("message", row.ID, "upsert")
	return true, nil
}

// prepare reads a new message and puts its parts in the bucket, ready for its row.
// prepared is a message ready to store, with what sorting it still needs.
type prepared struct {
	row    *db.InsertMessageParams
	sample Sample
	pinned bool
}

func (s *syncer) prepare(boxID string, m *imapclient.FetchMessageBuffer) (*prepared, error) {
	sent := m.Envelope.Date
	if sent.IsZero() {
		sent = m.InternalDate
	}
	row := db.InsertMessageParams{
		ID:        rand.Text(),
		AccountID: s.acc.ID,
		MailboxID: boxID,
		Uid:       int64(m.UID),
		MessageID: Hashed(m.Envelope.MessageID),
		SentAt:    pgtype.Timestamptz{Time: sent, Valid: true},
		Flags:     flagStrings(m.Flags),
		Size:      int32(m.RFC822Size),
	}
	raw := m.FindBodySection(whole)
	// An unparsable message still shows up, just without a body to read.
	parsed, err := Content(raw)
	if err != nil {
		slog.Warn("can't read message", "id", row.ID, "err", err)
	}
	meta := Meta{
		MessageID: m.Envelope.MessageID, Subject: m.Envelope.Subject, Snippet: parsed.Snippet,
		To: addrs(m.Envelope.To), Cc: addrs(m.Envelope.Cc),
		// Empty lists rather than null.
		Attachments: append([]File{}, parsed.Files...), Actions: append([]Action{}, parsed.Actions...),
		Rich: parsed.Rich != "", Unsubscribe: parsed.Unsubscribe,
	}
	if len(m.Envelope.From) > 0 {
		meta.FromName, meta.FromAddr = m.Envelope.From[0].Name, m.Envelope.From[0].Addr()
	}
	if len(m.Envelope.ReplyTo) > 0 && !strings.EqualFold(m.Envelope.ReplyTo[0].Addr(), meta.FromAddr) {
		meta.ReplyTo = m.Envelope.ReplyTo[0].Addr()
	}
	var pinned bool
	row.Category, row.Spam, pinned = s.sort(boxID, meta.FromAddr, parsed)
	refs := References(raw)
	for i, r := range refs {
		refs[i] = Hashed(r)
	}
	row.Refs = refs
	return &prepared{row: &row, sample: parsed.Sample, pinned: pinned}, s.keep(&row, meta, parsed)
}

// keep seals a message for the user: its key and Meta into the row, its parts into the bucket.
func (s *syncer) keep(row *db.InsertMessageParams, meta Meta, parsed Parsed) (err error) {
	key := seal.NewKey()
	if row.Key, err = seal.Wrap(s.pub, key); err != nil {
		return err
	}
	plain, _ := json.Marshal(meta)
	row.Sealed = seal.Encrypt(key, "meta", plain)
	for i, f := range parsed.Files {
		if err := s.store.Put(s.ctx, fmt.Sprintf("att/%s/%d", row.ID, i), seal.Encrypt(key, fmt.Sprintf("att/%d", i), f.Data), "application/octet-stream"); err != nil {
			return err
		}
	}
	if err := s.store.Put(s.ctx, "body/"+row.ID+".html", seal.Encrypt(key, "body", []byte(parsed.Body)), "application/octet-stream"); err != nil {
		return err
	}
	if meta.Rich {
		return s.store.Put(s.ctx, "rich/"+row.ID+".html", seal.Encrypt(key, "rich", []byte(parsed.Rich)), "application/octet-stream")
	}
	return nil
}

// changedFlags saves the flags the server reported as changed.
func (s *syncer) changedFlags(boxID string, msgs []*imapclient.FetchMessageBuffer) error {
	if len(msgs) == 0 {
		return nil
	}
	server := map[int64][]string{}
	uids := make([]int64, 0, len(msgs))
	for _, m := range msgs {
		server[int64(m.UID)] = flagStrings(m.Flags)
		uids = append(uids, int64(m.UID))
	}
	rows, err := s.q.ListFlagsFor(s.ctx, db.ListFlagsForParams{MailboxID: boxID, Uids: uids})
	if err != nil {
		return err
	}
	for _, r := range rows {
		if flags := server[r.Uid]; !slices.Equal(flags, r.Flags) {
			if err := s.q.SetFlags(s.ctx, db.SetFlagsParams{ID: r.ID, Flags: flags}); err != nil {
				return err
			}
			s.log("message", r.ID, "upsert")
		}
	}
	return nil
}

// gone deletes the messages the server doesn't have anymore. Only when the counts differ are the UIDs listed.
// ponytail: equal counts are trusted, a message without an envelope (never stored) could hide one that is gone.
func (s *syncer) gone(boxID string, onServer uint32) error {
	n, err := s.q.CountMessages(s.ctx, boxID)
	if err != nil || n == int64(onServer) {
		return err
	}
	var opts *imap.SearchOptions
	if caps := s.c.Caps(); caps.Has(imap.CapESearch) || caps.Has(imap.CapIMAP4rev2) {
		opts = &imap.SearchOptions{ReturnAll: true}
	}
	found, err := s.c.UIDSearch(&imap.SearchCriteria{}, opts).Wait()
	if err != nil {
		return err
	}
	uids := []int64{}
	for _, u := range found.AllUIDs() {
		uids = append(uids, int64(u))
	}
	ids, err := s.q.DeleteGone(s.ctx, db.DeleteGoneParams{MailboxID: boxID, Uids: uids})
	if err != nil {
		return err
	}
	return s.forget(ids)
}

// allFlags compares every UID's flags with what we stored, which also finds the messages that are gone.
func (s *syncer) allFlags(boxID string, onServer uint32) error {
	server := map[int64][]string{}
	if onServer > 0 {
		var all imap.UIDSet
		all.AddRange(1, 0)
		msgs, err := s.c.Fetch(all, &imap.FetchOptions{UID: true, Flags: true}).Collect()
		if err != nil {
			return err
		}
		for _, m := range msgs {
			server[int64(m.UID)] = flagStrings(m.Flags)
		}
	}
	stored, err := s.q.ListFlags(s.ctx, boxID)
	if err != nil {
		return err
	}
	for _, r := range stored {
		flags, ok := server[r.Uid]
		switch {
		case !ok:
			if err = s.q.DeleteMessage(s.ctx, r.ID); err == nil {
				err = s.forget([]string{r.ID})
			}
		case !slices.Equal(flags, r.Flags):
			if err = s.q.SetFlags(s.ctx, db.SetFlagsParams{ID: r.ID, Flags: flags}); err == nil {
				s.log("message", r.ID, "upsert")
			}
		default:
			continue
		}
		if err != nil {
			return err
		}
	}
	return nil
}

var roles = map[imap.MailboxAttr]string{
	imap.MailboxAttrSent:    "sent",
	imap.MailboxAttrDrafts:  "drafts",
	imap.MailboxAttrTrash:   "trash",
	imap.MailboxAttrJunk:    "junk",
	imap.MailboxAttrArchive: "archive",
	imap.MailboxAttrAll:     "archive",
}

// Names servers without SPECIAL-USE commonly use, also German ones, and also under INBOX (INBOX.Sent).
var roleNames = map[string]string{
	"sent": "sent", "sent items": "sent", "sent messages": "sent", "gesendet": "sent", "gesendete objekte": "sent",
	"gesendete elemente": "sent",
	"drafts":             "drafts", "entwürfe": "drafts",
	"trash": "trash", "deleted items": "trash", "deleted messages": "trash", "papierkorb": "trash",
	"gelöschte elemente": "trash", "gelöschte objekte": "trash",
	"junk": "junk", "spam": "junk", "junk-e-mail": "junk",
	"archive": "archive", "archiv": "archive",
	"snoozed": "snoozed",
}

// skipVirtual leaves out folders that only show messages from other folders, which would show them twice. Except
// \All where there's no archive: archived mail in Gmail is only there.
func skipVirtual(all []*imap.ListData) []*imap.ListData {
	archive := slices.ContainsFunc(all, func(b *imap.ListData) bool { return slices.Contains(b.Attrs, imap.MailboxAttrArchive) })
	return slices.DeleteFunc(all, func(b *imap.ListData) bool {
		return slices.ContainsFunc(b.Attrs, func(a imap.MailboxAttr) bool {
			return a == imap.MailboxAttrNoSelect || a == imap.MailboxAttrNonExistent || a == imap.MailboxAttrFlagged ||
				a == imap.MailboxAttrAll && archive
		})
	})
}

func role(b *imap.ListData) string {
	if strings.EqualFold(b.Mailbox, "INBOX") {
		return "inbox"
	}
	for _, a := range b.Attrs {
		if r, ok := roles[a]; ok {
			return r
		}
	}
	name := strings.ToLower(b.Mailbox)
	if b.Delim != 0 {
		name = strings.TrimPrefix(name, "inbox"+string(b.Delim))
	}
	return roleNames[name]
}

func addrs(list []imap.Address) []string {
	s := make([]string, len(list))
	for i, a := range list {
		s[i] = a.Addr()
	}
	return s
}

// flagStrings returns the flags sorted, so stored and fetched lists compare equal. \Recent is left out: it only
// holds for the session that first sees a message, so the next sync would count every message as changed.
func flagStrings(flags []imap.Flag) []string {
	s := []string{}
	for _, f := range flags {
		if f != `\Recent` {
			s = append(s, string(f))
		}
	}
	slices.Sort(s)
	return s
}

// model lets the user's sorting model decide what the rules weren't sure of. Without the embed service, or when it
// fails, the rules stay.
func (s *syncer) model(ready []*prepared) {
	if Sorting == nil {
		return
	}
	var open []*prepared
	var samples []Sample
	for _, p := range ready {
		if p != nil && !p.pinned {
			open = append(open, p)
			samples = append(samples, p.sample)
		}
	}
	if len(open) == 0 {
		return
	}
	probs, err := Sorting.Classify(s.ctx, s.q, s.master, s.acc.UserID, samples)
	if err != nil {
		slog.Warn("sorting model", "account", s.acc.ID, "err", err)
		return
	}
	for i, p := range open {
		p.row.Category = decide(probs[i], p.row.Category)
	}
}
