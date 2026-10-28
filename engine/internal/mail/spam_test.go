// SPDX-License-Identifier: AGPL-3.0-only

package mail

import (
	"strings"
	"testing"

	"github.com/emersion/go-message/mail"
)

func TestSigned(t *testing.T) {
	from := "From: Sparkasse <info@spk-sicherheit-update.com>\r\n\r\n"
	for _, c := range []struct {
		name    string
		results string
		want    bool
	}{
		{"unchecked", "", false},
		{"not confirmed", "mx.gmx.net; dkim=none; spf=softfail", false},
		{"dkim for the domain", "mx.gmx.net; dkim=pass header.d=spk-sicherheit-update.com", true},
		{"dkim for another domain", "mx.gmx.net; dkim=pass header.d=mailer.example", false},
		{"dmarc", "mx.google.com; dkim=pass header.i=@mailer.example; dmarc=pass", true},
	} {
		raw := from
		if c.results != "" {
			raw = "Authentication-Results: " + c.results + "\r\n" + from
		}
		r, err := mail.CreateReader(strings.NewReader(raw))
		if err != nil {
			t.Fatal(err)
		}
		if got := signed(r.Header); got != c.want {
			t.Errorf("%s: %v, want %v", c.name, got, c.want)
		}
	}
}
