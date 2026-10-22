// SPDX-License-Identifier: AGPL-3.0-only

package mail

import (
	"strings"
	"testing"
)

func TestCategory(t *testing.T) {
	for _, c := range []struct{ headers, want string }{
		{"From: Lena <lena@hartmann.example>\r\nSubject: Freitag?", "primary"},
		{"From: Lena <lena@hartmann.example>\r\nSubject: Re: Rechnung März\r\nIn-Reply-To: <a@x>", "primary"},
		{"From: LinkedIn <invitations@linkedin.com>\r\nSubject: Jonas wants to connect\r\nList-Unsubscribe: <https://x>", "social"},
		{"From: Facebook <notification@facebookmail.com>\r\nSubject: You have a new message", "social"},
		{"From: Shop <news@shop.example>\r\nSubject: 30% auf alles, nur heute\r\nList-Unsubscribe: <https://x>", "promotions"},
		{"From: Shop <news@shop.example>\r\nSubject: Black Friday starts now\r\nPrecedence: bulk", "promotions"},
		{"From: Ben <ben@substack.com>\r\nSubject: Notes on Go generics\r\nList-Unsubscribe: <https://x>", "newsletters"},
		{"From: Amazon <shipment-tracking@amazon.de>\r\nSubject: Ihre Bestellung wurde versandt", "updates"},
		{"From: GitHub <notifications@github.com>\r\nSubject: [nouvex/mail] Fix sync (#12)\r\nList-Unsubscribe: <https://x>", "updates"},
		{"From: Bank <noreply@bank.example>\r\nSubject: Neue Nachricht in Ihrem Postfach", "updates"},
		{"From: Jira <jira@acme.example>\r\nSubject: [ACME-1] Login broken\r\nAuto-Submitted: auto-generated", "updates"},
		{"From: Shop <news@shop.example>\r\nSubject: Your order has shipped\r\nList-Unsubscribe: <https://x>", "updates"},
		{"From: Lyft <no-reply@marketing.lyftmail.com>\r\nSubject: Claim it: 75\u00a0% off\r\nList-Unsubscribe: <https://x>", "promotions"},
		{"From: Cloudflare <noreply@notify.cloudflare.com>\r\nSubject: Neues Mitglied\r\nList-Unsubscribe: <https://x>", "updates"},
		{"From: Bloomwell <noreply@bloomwell.de>\r\nSubject: Dein Login-Code\r\nList-Unsubscribe: <https://x>", "updates"},
		{"From: 1&1 <mobile-team@1und1.de>\r\nSubject: Jetzt vorbestellen\r\nReturn-Path: <bounce_1+ab@bounce.1und1.de>", "newsletters"},
		{"From: Vivid <service@email.vivid.money>\r\nSubject: 150.0€ bonus expires\r\nFeedback-ID: 1:2:mailing", "promotions"},
	} {
		p, err := Content([]byte(c.headers + "\r\n\r\nHi"))
		if err != nil || p.Category != c.want {
			t.Errorf("%q: got %q, want %q (%v)", strings.SplitN(c.headers, "\r\n", 2)[0], p.Category, c.want, err)
		}
	}
	if p, _ := Content([]byte("From: TikTok <register@account.tiktok.com>\r\nSubject: Login\r\n\r\nYour code: 483920")); p.Category != "updates" {
		t.Errorf("code: %q", p.Category)
	}
	invite := "From: Felix <felix@x.example>\r\nSubject: Einladung: Status\r\nContent-Type: text/calendar\r\n\r\n" + invite
	if p, _ := Content([]byte(invite)); p.Category != "primary" || len(p.Actions) != 1 {
		t.Errorf("invite: %q %+v", p.Category, p.Actions)
	}
}
