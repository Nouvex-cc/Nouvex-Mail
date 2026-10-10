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
// deleted.
// ponytail: one connection per account and IDLE only; servers without IDLE need polling, many accounts a pool.
func Watch(ctx context.Context, q *db.Queries, master []byte, accountID string, changed func()) {
	for {
		err := watch(ctx, q, master, accountID, changed)
		if ctx.Err() != nil || errors.Is(err, pgx.ErrNoRows) {
			return
		}
		slog.Warn("watch dropped", "account", accountID, "err", err)
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Minute):
		}
	}
}

func watch(ctx context.Context, q *db.Queries, master []byte, accountID string, changed func()) error {
	acc, err := q.GetAccount(ctx, accountID)
	if err != nil {
		return err
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
	done := make(chan error, 1)
	go func() { done <- idle.Wait() }()
	for {
		select {
		case <-news:
			changed()
		case err := <-done:
			return errors.Join(errors.New("idle ended"), err)
		case <-ctx.Done():
			_ = idle.Close()
			<-done
			return ctx.Err()
		}
	}
}
