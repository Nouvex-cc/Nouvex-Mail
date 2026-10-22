// SPDX-License-Identifier: AGPL-3.0-only

package mail

import (
	"regexp"
	"strings"

	"github.com/emersion/go-message/mail"
)

var (
	// Mail from these networks is about your contacts there: invitations, messages, mentions.
	socialDomains = []string{
		"facebookmail.com", "linkedin.com", "x.com", "twitter.com", "instagram.com", "tiktok.com", "pinterest.com",
		"redditmail.com", "xing.com", "discord.com", "youtube.com", "snapchat.com", "threads.net", "bsky.app",
		"strava.com", "meetup.com", "nextdoor.com",
	}
	// Machines sending one mail to one person: notifications, receipts, alerts.
	robot = regexp.MustCompile(`(?i)^(no-?reply|do-?not-?reply|notifications?|notify|alerts?|mailer|bounce|accounts?|security|billing|invoices?|orders?|shipping|receipts?)\b`)
	// Services send these with an unsubscribe link too (GitHub, Jira, banks); they still aren't newsletters.
	notifier = regexp.MustCompile(`(?i)^(notifications?|notify|alerts?)\b`)
	// Senders keep their notifications apart from their marketing: notify.cloudflare.com, trx.mail.disneyplus.com.
	notifierHost = regexp.MustCompile(`(?i)^(notifications?|notify|alerts?|trx|transactional|accounts?)\.`)
	// German words are listed whole, see codeWord.
	transactional = regexp.MustCompile(`(?i)\b(order|receipt|invoice|payment|shipped|shipping|delivery|delivered|tracking|booking|reservation|confirm|confirmation|statement|password|alert|sign-in|login|log-in|code|verification|verify|reminder|action required|subscription|renewal|ticket|rechnung|bestellung|bestellbestätigung|zahlung|versand|versandbestätigung|lieferung|zugestellt|buchung|buchungsbestätigung|reservierung|bestätigung|kontoauszug|passwort|sicherheitswarnung|anmeldung|einloggen|verifizierung|erinnerung|abo|kündigung)\b`)
	sale          = regexp.MustCompile(`(?i)(\d[\s\x{a0}\x{202f}]?%|€[\s\x{a0}]?\d|\d[\s\x{a0}]?€|\$[\s\x{a0}]?\d)|\b(sale|deal|deals|offer|discount|coupon|promo|free shipping|black friday|cyber monday|last chance|ends today|limited time|shop now|angebot|angebote|rabatt|gutschein|aktion|nur heute|versandkostenfrei|schnäppchen|reduziert)\b`)
)

// category sorts a message into an inbox tab from its headers and subject, the way Proton does, without reading the
// body: social for networks, promotions for bulk mail selling something, updates for notifications and receipts,
// newsletters for other bulk mail, primary for the rest.
// ponytail: fixed rules; learning from where the user moves mail is the next step, a model only for what's left.
func category(h mail.Header, subject string, acts []Action) string {
	var from string
	if list, _ := h.AddressList("From"); len(list) > 0 {
		from = strings.ToLower(list[0].Address)
	}
	local, domain, _ := strings.Cut(from, "@")
	// A sign-in code is an update, also from a network. An invitation isn't: people send those.
	for _, a := range acts {
		if a.Kind == "code" {
			return "updates"
		}
	}
	for _, d := range socialDomains {
		if domain == d || strings.HasSuffix(domain, "."+d) {
			return "social"
		}
	}
	precedence := strings.ToLower(h.Get("Precedence"))
	// Mailing services don't always add an unsubscribe link, but they collect bounces and feedback per mailing.
	bounces := strings.Contains(strings.ToLower(h.Get("Return-Path")), "bounce")
	bulk := h.Get("List-Unsubscribe") != "" || precedence == "bulk" || precedence == "list" || bounces ||
		h.Get("Feedback-ID") != ""
	if bulk && sale.MatchString(subject) {
		return "promotions"
	}
	// Someone answering you, even about an invoice.
	if !bulk && !robot.MatchString(local) && h.Get("In-Reply-To") != "" {
		return "primary"
	}
	auto := strings.HasPrefix(strings.ToLower(h.Get("Auto-Submitted")), "auto-generated")
	if transactional.MatchString(subject) || auto || notifier.MatchString(local) || notifierHost.MatchString(domain) || (!bulk && robot.MatchString(local)) {
		return "updates"
	}
	if bulk {
		return "newsletters"
	}
	return "primary"
}
