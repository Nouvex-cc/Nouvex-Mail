// SPDX-License-Identifier: AGPL-3.0-only

package mail

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/emersion/go-imap/v2/imapclient"
	"github.com/jackc/pgx/v5"

	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/db"
	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/secret"
)

// Watch keeps an IDLE connection on the account's INBOX and calls changed when the server reports new, deleted or
// changed mail, and
// once after every (re)connect to catch up on what came in meanwhile. It returns when ctx ends or the account is
// deleted or archived.
// ponytail: one connection per account and IDLE only; servers without IDLE need polling, many accounts a pool.
// failed hears why a connection couldn't be made, e.g. a wrong password.
func Watch(ctx context.Context, q *db.Queries, master []byte, accountID string, changed func(), failed func(error)) {
	for {
		err := watch(ctx, q, master, accountID, changed)
		if ctx.Err() != nil || errors.Is(err, pgx.ErrNoRows) || errors.Is(err, errArchived) {
			return
		}
		// Servers end idle connections now and then, e.g. Gmail; that's no reason to tell the user.
		wait := 5 * time.Second
		if !errors.Is(err, errDropped) {
			slog.Warn("watch failed", "account", accountID, "err", err)
			failed(err)
			wait = time.Minute
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
	}
}

var (
	errArchived = errors.New("archived")
	errDropped  = errors.New("idle ended")
)

func watch(ctx context.Context, q *db.Queries, master []byte, accountID string, changed func()) error {
	acc, err := q.GetAccount(ctx, accountID)
	if err != nil {
		return err
	}
	if acc.ArchivedAt.Valid {
		return errArchived
	}
	pass, err := secret.Open(master, acc.Secret)
	if err != nil {
		return err
	}
	news := make(chan struct{}, 1)
	notify := func() {
		select {
		case news <- struct{}{}:
		default:
		}
	}
	c, err := DialIMAP(acc.ImapHost, int(acc.ImapPort), acc.Username, pass, &imapclient.UnilateralDataHandler{
		Mailbox: func(d *imapclient.UnilateralDataMailbox) {
			if d.NumMessages != nil {
				notify()
			}
		},
		Expunge: func(uint32) { notify() },
		// The data has to be read, or the connection stalls.
		Fetch: func(m *imapclient.FetchMessageData) {
			_, _ = m.Collect()
			notify()
		},
	})
	if err != nil {
		return err
	}
	defer func() { _ = c.Close() }()
	if _, err := c.Select("INBOX", nil).Wait(); err != nil {
		return err
	}
	idle, err := c.Idle()
	if err != nil {
		return err
	}
	// Only now: mail that arrives from here on is reported by IDLE, everything before is caught up by this sync.
	changed()
	var idleErr error
	done := make(chan struct{})
	go func() {
		idleErr = idle.Wait()
		close(done)
	}()
	// ponytail: archiving or removing the account ends the connection within 5 minutes, not at once.
	check := time.NewTicker(5 * time.Minute)
	defer check.Stop()
	for {
		select {
		case <-news:
			changed()
		case <-check.C:
			now, err := q.GetAccount(ctx, accountID)
			if err == nil && now.ArchivedAt.Valid {
				err = errArchived
			}
			if err != nil {
				_ = idle.Close()
				<-done
				return err
			}
		case <-done:
			return errors.Join(errDropped, idleErr)
		case <-ctx.Done():
			_ = idle.Close()
			<-done
			return ctx.Err()
		}
	}
}
