// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"cmp"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/getsentry/sentry-go"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"

	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/db"
	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/mail"
	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/msg"
	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/secret"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	if err := run(); err != nil {
		slog.Error("engine stopped", "err", err)
		os.Exit(1)
	}
}

func run() error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if dsn := os.Getenv("SENTRY_DSN"); dsn != "" {
		if err := sentry.Init(sentry.ClientOptions{Dsn: dsn}); err != nil {
			return err
		}
	}
	if os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT") != "" {
		exp, err := otlptracehttp.New(ctx)
		if err != nil {
			return err
		}
		tp := sdktrace.NewTracerProvider(sdktrace.WithBatcher(exp))
		defer func() { _ = tp.Shutdown(context.Background()) }()
		otel.SetTracerProvider(tp)
	}

	master, err := secret.Key()
	if err != nil {
		return err
	}
	bucket, err := mail.OpenBucket(ctx)
	if err != nil {
		return err
	}
	store := mail.Store{Put: bucket.Put, Drop: bucket.Drop}
	pool, err := pgxpool.New(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		return err
	}
	defer pool.Close()

	// Reconnect forever; the default gives up after two minutes, e.g. while the laptop sleeps.
	nc, err := nats.Connect(cmp.Or(os.Getenv("NATS_URL"), nats.DefaultURL), nats.MaxReconnects(-1))
	if err != nil {
		return err
	}
	defer func() { _ = nc.Drain() }()
	js, err := jetstream.New(nc)
	if err != nil {
		return err
	}
	// A work queue: a command is gone once it's done, so messages to send don't stay in the stream's files.
	commands := jetstream.StreamConfig{Name: "COMMANDS", Subjects: []string{"cmd.>"}, Retention: jetstream.WorkQueuePolicy}
	stream, err := js.CreateOrUpdateStream(ctx, commands)
	if err != nil {
		// A stream made before can't change its retention; what's queued in it is dropped with it.
		_ = js.DeleteStream(ctx, commands.Name)
		if stream, err = js.CreateStream(ctx, commands); err != nil {
			return err
		}
	}
	cons, err := stream.CreateOrUpdateConsumer(ctx, jetstream.ConsumerConfig{
		Durable:        "engine",
		FilterSubjects: []string{"cmd.mailbox.sync", "cmd.message.update", "cmd.message.send", "cmd.draft.save"},
		AckPolicy:      jetstream.AckExplicitPolicy,
		// A server that is down or a wrong password shouldn't be retried forever.
		MaxDeliver: 5,
		// A first sync of a big mailbox takes a while; redelivering it meanwhile would start a second one.
		AckWait: 15 * time.Minute,
		// Also bounds the per-account queues below.
		MaxAckPending: 1000,
	})
	if err != nil {
		return err
	}

	// The account shows why it isn't syncing until a sync works again.
	failed := func(id string, err error) {
		q := db.New(pool)
		_ = q.SetSyncError(ctx, db.SetSyncErrorParams{ID: id, SyncError: pgtype.Text{String: err.Error(), Valid: true}})
		acc, _ := q.GetAccount(ctx, id)
		e := err.Error()
		ev, _ := json.Marshal(msg.MailboxSynced{AccountId: id, Version: int(acc.Version), Error: &e})
		_ = nc.Publish("evt.mailbox.synced", ev)
	}

	// Every account gets an IDLE watcher that queues a sync when new mail arrives.
	var mu sync.Mutex
	watched := map[string]bool{}
	watch := func(id string) {
		mu.Lock()
		defer mu.Unlock()
		if watched[id] {
			return
		}
		watched[id] = true
		cmd, _ := json.Marshal(msg.MailboxSync{AccountId: id})
		go func() {
			mail.Watch(ctx, db.New(pool), master, id, func() {
				if _, err := js.Publish(ctx, "cmd.mailbox.sync", cmd); err != nil {
					slog.Error("queue sync", "account", id, "err", err)
				}
			}, func(err error) { failed(id, err) })
			mu.Lock()
			delete(watched, id)
			mu.Unlock()
		}()
	}
	ids, err := db.New(pool).ListAccountIDs(ctx)
	if err != nil {
		return err
	}
	for _, id := range ids {
		watch(id)
	}
	go checkArchived(ctx, db.New(pool), js, bucket)

	if err := bucket.Sweep(ctx, db.New(pool)); err != nil {
		slog.Error("sweep", "err", err)
	}

	// syncAccount syncs an account and tells clients while it runs and once it's done. Every saved batch goes out
	// right away, so they fill up during a long first sync.
	syncAccount := func(id string) error {
		start, _ := json.Marshal(msg.MailboxSyncing{AccountId: id})
		_ = nc.Publish("evt.mailbox.syncing", start)
		v, err := mail.Sync(ctx, pool, store, master, id, func(v int64) {
			n := int(v)
			ev, _ := json.Marshal(msg.MailboxSyncing{AccountId: id, Version: &n})
			_ = nc.Publish("evt.mailbox.syncing", ev)
		})
		if err != nil {
			slog.Error("sync failed", "account", id, "err", err)
			failed(id, err)
			return err
		}
		_ = db.New(pool).SetSyncError(ctx, db.SetSyncErrorParams{ID: id})
		ev, _ := json.Marshal(msg.MailboxSynced{AccountId: id, Version: int(v)})
		if err := nc.Publish("evt.mailbox.synced", ev); err != nil {
			return err
		}
		slog.Info("synced", "account", id, "version", v)
		watch(id)
		return nil
	}

	// handle runs one command of an account and returns whether the account owes a sync: one that more queued
	// commands would repeat right away is left for later.
	handle := func(m jetstream.Msg, owed, queued bool) bool {
		switch m.Subject() {
		case "cmd.message.send":
			send(ctx, m, nc, js, db.New(pool), bucket, master)
			return owed
		case "cmd.draft.save":
			var d msg.DraftSave
			if err := json.Unmarshal(m.Data(), &d); err != nil {
				_ = m.Term()
				return owed
			}
			if err := mail.SaveDraft(ctx, db.New(pool), master, d); err != nil {
				slog.Error("draft failed", "account", d.AccountId, "err", err)
				_ = m.NakWithDelay(10 * time.Second)
				return owed
			}
			_ = m.Ack()
			sync, _ := json.Marshal(msg.MailboxSync{AccountId: d.AccountId})
			_, _ = js.Publish(ctx, "cmd.mailbox.sync", sync)
			return owed
		}
		var cmd msg.MailboxSync
		var update msg.MessageUpdate
		var err error
		if m.Subject() == "cmd.message.update" {
			err = json.Unmarshal(m.Data(), &update)
			cmd.AccountId = update.AccountId
		} else {
			err = json.Unmarshal(m.Data(), &cmd)
		}
		if err != nil {
			slog.Warn("bad command", "subject", m.Subject(), "err", err)
			_ = m.Term()
			return owed
		}
		if update.MessageId != "" {
			// A message that is gone already can't be changed anymore.
			if err := mail.Update(ctx, db.New(pool), master, update); errors.Is(err, pgx.ErrNoRows) {
				_ = m.Term()
				return owed
			} else if err != nil {
				slog.Error("update failed", "account", update.AccountId, "err", err)
				_ = m.NakWithDelay(time.Minute)
				return owed
			}
			if mail.Saved(update) {
				if acc, err := db.New(pool).GetAccount(ctx, update.AccountId); err == nil {
					ev, _ := json.Marshal(msg.MailboxSynced{AccountId: update.AccountId, Version: int(acc.Version)})
					_ = nc.Publish("evt.mailbox.synced", ev)
				}
				_ = m.Ack()
				return owed
			}
		}
		if queued {
			_ = m.Ack()
			return true
		}
		if err := syncAccount(cmd.AccountId); err != nil {
			_ = m.NakWithDelay(time.Minute)
			return false
		}
		_ = m.Ack()
		return false
	}
	// Commands of one account run in order, one at a time, so a message is sent after its draft was saved; accounts
	// don't wait for each other.
	// ponytail: a queue lives as long as the engine, one goroutine per account that ever had a command.
	var qmu sync.Mutex
	queues := map[string]chan jetstream.Msg{}
	cc, err := cons.Consume(func(m jetstream.Msg) {
		var cmd struct {
			AccountId string `json:"accountId"`
		}
		_ = json.Unmarshal(m.Data(), &cmd)
		qmu.Lock()
		q, ok := queues[cmd.AccountId]
		if !ok {
			// Never fills up, see MaxAckPending.
			q = make(chan jetstream.Msg, 1000)
			queues[cmd.AccountId] = q
			go func(id string) {
				owed := false
				for m := range q {
					// A sync owed when the queue runs empty runs right away; its errors show on the account.
					if owed = handle(m, owed, len(q) > 0); owed && len(q) == 0 {
						_ = syncAccount(id)
						owed = false
					}
				}
			}(cmd.AccountId)
		}
		qmu.Unlock()
		q <- m
	})
	if err != nil {
		return err
	}
	defer cc.Stop()

	// Settings are checked before an account is saved; slow servers mustn't hold up other checks.
	check, err := nc.Subscribe("rpc.account.check", func(m *nats.Msg) {
		go func() {
			var req msg.AccountCheck
			res := msg.AccountChecked{}
			err := json.Unmarshal(m.Data, &req)
			if err == nil {
				err = mail.Check(master, req)
			}
			if err != nil {
				e := err.Error()
				res.Error = &e
			}
			b, _ := json.Marshal(res)
			_ = m.Respond(b)
		}()
	})
	if err != nil {
		return err
	}
	defer func() { _ = check.Unsubscribe() }()

	go runJobs(ctx, db.New(pool), js, master)

	slog.Info("engine running")
	<-ctx.Done()
	return nil
}

// send runs once and reports the outcome as evt.message.sent: the server may have taken a message even when we saw
// an error, and sending it twice is worse than asking the user to try again.
func send(ctx context.Context, m jetstream.Msg, nc *nats.Conn, js jetstream.JetStream, q *db.Queries, bucket *mail.Bucket, master []byte) {
	defer func() { _ = m.Ack() }()
	var cmd msg.MessageSend
	if err := json.Unmarshal(m.Data(), &cmd); err != nil {
		slog.Warn("bad command", "subject", m.Subject(), "err", err)
		return
	}
	// Send later: kept as a job until it's due, then it comes back here without sendAt.
	if cmd.SendAt != nil && cmd.SendAt.After(time.Now()) {
		at := *cmd.SendAt
		cmd.SendAt = nil
		plain, _ := json.Marshal(cmd)
		payload, _ := json.Marshal(scheduled{Sealed: secret.Seal(master, plain)})
		if err := q.AddJob(ctx, db.AddJobParams{
			ID: rand.Text(), AccountID: cmd.AccountId, Kind: "send", Payload: payload,
			RunAt: pgtype.Timestamptz{Time: at, Valid: true},
		}); err != nil {
			slog.Error("schedule send", "account", cmd.AccountId, "err", err)
		}
		return
	}
	ev := msg.MessageSent{AccountId: cmd.AccountId}
	raw, err := mail.Send(ctx, q, bucket.Get, master, cmd)
	if err != nil {
		slog.Error("send failed", "account", cmd.AccountId, "err", err)
		e := err.Error()
		ev.Error = &e
	} else {
		if cmd.DraftId != nil {
			if err := mail.DiscardDraft(ctx, q, master, cmd.AccountId, *cmd.DraftId); err != nil {
				slog.Warn("removing the draft failed", "account", cmd.AccountId, "err", err)
			}
		}
		if err := mail.SaveSent(ctx, q, master, cmd.AccountId, raw); err != nil {
			slog.Warn("saving to Sent failed", "account", cmd.AccountId, "err", err)
		}
		for _, a := range cmd.Attachments {
			_ = bucket.Remove(ctx, "upload/"+cmd.AccountId+"/"+a.Id)
		}
		// So the copy shows up in Sent and the draft leaves Drafts.
		sync, _ := json.Marshal(msg.MailboxSync{AccountId: cmd.AccountId})
		_, _ = js.Publish(ctx, "cmd.mailbox.sync", sync)
	}
	b, _ := json.Marshal(ev)
	_ = nc.Publish("evt.message.sent", b)
}

// checkArchived syncs archived accounts once a day; they have no watcher, and opening one syncs it too. Uploads for
// messages that were never sent go then as well.
// ponytail: counts the day from the engine's start, a restart pushes the next check back.
func checkArchived(ctx context.Context, q *db.Queries, js jetstream.JetStream, bucket *mail.Bucket) {
	tick := time.NewTicker(24 * time.Hour)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
		if err := bucket.SweepUploads(ctx); err != nil {
			slog.Error("sweep uploads", "err", err)
		}
		ids, err := q.ListArchivedAccountIDs(ctx)
		if err != nil {
			slog.Error("archived accounts", "err", err)
			continue
		}
		for _, id := range ids {
			cmd, _ := json.Marshal(msg.MailboxSync{AccountId: id})
			if _, err := js.Publish(ctx, "cmd.mailbox.sync", cmd); err != nil {
				slog.Error("queue sync", "account", id, "err", err)
			}
		}
	}
}

// A message to send later is sealed with SECRETS_KEY while it waits: the engine has to read it when it's due.
type scheduled struct {
	Sealed []byte `json:"sealed"`
}

// runJobs turns due jobs back into commands: a message to send, a snoozed message to move back to the INBOX.
// ponytail: polls every 20 seconds, so things happen up to 20 seconds late.
func runJobs(ctx context.Context, q *db.Queries, js jetstream.JetStream, master []byte) {
	tick := time.NewTicker(20 * time.Second)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
		jobs, err := q.TakeDueJobs(ctx)
		if err != nil {
			slog.Error("jobs", "err", err)
			continue
		}
		for _, j := range jobs {
			subject, data := "cmd.message.send", j.Payload
			var s scheduled
			if _ = json.Unmarshal(j.Payload, &s); s.Sealed != nil {
				plain, err := secret.Open(master, s.Sealed)
				if err != nil {
					slog.Error("job", "kind", j.Kind, "err", err)
					continue
				}
				data = []byte(plain)
			}
			if j.Kind == "unsnooze" {
				var p struct{ MessageID string }
				_ = json.Unmarshal(j.Payload, &p)
				// Jobs from before Message-IDs were stored hashed.
				if len(p.MessageID) != 64 {
					p.MessageID = mail.Hashed(p.MessageID)
				}
				// Moved out of Snoozed meanwhile: nothing to bring back.
				id, err := q.FindByRole(ctx, db.FindByRoleParams{AccountID: j.AccountID, MessageID: p.MessageID, Role: "snoozed"})
				if err != nil {
					continue
				}
				yes := true
				subject = "cmd.message.update"
				data, _ = json.Marshal(msg.MessageUpdate{AccountId: j.AccountID, MessageId: id, Inbox: &yes})
			}
			if _, err := js.Publish(ctx, subject, data); err != nil {
				slog.Error("job", "kind", j.Kind, "err", err)
				_ = q.AddJob(ctx, db.AddJobParams(j))
			}
		}
	}
}
