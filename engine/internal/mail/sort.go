// SPDX-License-Identifier: AGPL-3.0-only

package mail

import (
	"strings"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapclient"

	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/db"
)

// loadSorting reads what sorts this account's new mail. Both are small: one row per corrected sender and per address
// written to.
func (s *syncer) loadSorting() error {
	rules, err := s.q.ListSenderRules(s.ctx, s.acc.UserID)
	if err != nil {
		return err
	}
	contacts, err := s.q.ListContacts(s.ctx, s.acc.UserID)
	if err != nil {
		return err
	}
	s.rules, s.contacts, s.roles = map[string]db.ListSenderRulesRow{}, map[string]bool{}, map[string]string{}
	for _, r := range rules {
		s.rules[r.Sender] = r
	}
	for _, c := range contacts {
		s.contacts[c] = true
	}
	return nil
}

// Sender is how senders are kept: SHA-256 of the lowercased address, or of "@domain" for a whole domain. Clients hash
// the same way to make a rule.
func Sender(addr string) string {
	return Hashed(strings.ToLower(addr))
}

// sort decides a new message's tab and whether it's spam. What the user said about the sender wins, the address over
// its domain; mail from someone they wrote to is from a person; then what the message itself shows. Mail the user
// sent or drafted is never spam.
func (s *syncer) sort(boxID, from string, p Parsed) (category string, spam bool) {
	category, spam = p.Category, p.Spam
	// A message that couldn't be read has no tab of its own; clients only know the five.
	if category == "" {
		category = "primary"
	}
	if s.contacts[Sender(from)] {
		category, spam = "primary", false
	}
	for _, key := range []string{Sender("@" + domainOf(from)), Sender(from)} {
		r, ok := s.rules[key]
		if !ok {
			continue
		}
		if r.Category.Valid {
			category = r.Category.String
		}
		if r.Spam.Valid {
			spam = r.Spam.Bool
		}
	}
	if role := s.roles[boxID]; role == "sent" || role == "drafts" {
		spam = false
	}
	return category, spam
}

// wroteTo remembers everyone the user sent these messages to.
func (s *syncer) wroteTo(msgs []*imapclient.FetchMessageBuffer) error {
	var fresh []string
	for _, m := range msgs {
		if m.Envelope == nil {
			continue
		}
		for _, list := range [][]imap.Address{m.Envelope.To, m.Envelope.Cc, m.Envelope.Bcc} {
			for _, a := range list {
				if h := Sender(a.Addr()); a.Addr() != "" && !s.contacts[h] {
					s.contacts[h] = true
					fresh = append(fresh, h)
				}
			}
		}
	}
	if len(fresh) == 0 {
		return nil
	}
	return s.q.AddContacts(s.ctx, db.AddContactsParams{UserID: s.acc.UserID, Hashes: fresh})
}
