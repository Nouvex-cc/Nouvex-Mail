// SPDX-License-Identifier: AGPL-3.0-only

package mail

import (
	"os"
	"strings"
	"testing"
)

func TestSpam(t *testing.T) {
	phish := "From: \"PayPal Service\" <secure@account-verify-center.top>\r\nTo: you@example.com\r\nSubject: Your account has been limited\r\nContent-Type: text/html\r\n\r\n" +
		`<p>Dear Customer, we noticed unusual activity. Your account access has been limited until you verify your identity.</p>` +
		`<p><a href="http://account-verify-center.top/login">www.paypal.com/verify</a> Please confirm your billing information within 24 hours or your account will be suspended permanently.</p>`
	bank := "From: Sparkasse <info@spk-sicherheit-update.com>\r\nSubject: Wichtig: Ihr Konto wurde gesperrt\r\n\r\n" +
		"Sehr geehrter Kunde, aufgrund verdächtiger Aktivitäten wurde Ihr Online-Banking gesperrt. Bitte bestätigen Sie Ihre Daten innerhalb von 24 Stunden."
	friend := "From: Lena <lena@example.org>\r\nTo: you@example.com\r\nSubject: Saturday\r\n\r\nAre we still on for the hike on Saturday? I can bring sandwiches. Let me know when you want to leave."
	for _, c := range []struct {
		name string
		raw  string
		want bool
	}{
		{"phishing", phish, true},
		{"a friend", friend, false},
		// German wording alone isn't enough: the model learned from English mail.
		{"bank notice", bank, false},
		{"bank notice the provider couldn't confirm", "Authentication-Results: mx.gmx.net; dkim=none; spf=softfail\r\n" + bank, true},
		// Proven to come from its domain: the provider's filter decides, not ours, even with a link to elsewhere.
		{"signed bank notice", "Authentication-Results: mx.gmx.net; dkim=pass header.d=spk-sicherheit-update.com\r\n" + bank, false},
		{"signed newsletter", "Authentication-Results: mx.google.com; dkim=pass header.i=@account-verify-center.top; dmarc=pass\r\n" + phish, false},
		// iCloud puts each check into a header of its own, BIMI first. A GitHub notification is signed all the same.
		{"signed, as iCloud says it", "Authentication-Results: bimi.icloud.com; bimi=declined header.d=account-verify-center.top\r\n" +
			"Authentication-Results: dmarc.icloud.com; dmarc=pass header.from=account-verify-center.top\r\n" +
			"Authentication-Results: dkim-verifier.icloud.com; dkim=pass header.d=account-verify-center.top\r\n" +
			"Authentication-Results: spf.icloud.com; spf=pass smtp.mailfrom=account-verify-center.top\r\n" + phish, false},
		// A pass the sender wrote into the mail itself, under another name than the provider's, doesn't count.
		{"forged pass", "Authentication-Results: mx.gmx.net; dkim=none; spf=softfail\r\n" +
			"Authentication-Results: mx.google.com; dkim=pass header.d=spk-sicherheit-update.com; dmarc=pass\r\n" + bank, true},
	} {
		p, err := Content([]byte(c.raw))
		if err != nil {
			t.Fatal(err)
		}
		if p.Spam != c.want {
			logit, threshold := SpamScore(p.Tokens)
			t.Errorf("%s: spam %v, want %v (log-odds %.1f, threshold %.1f)", c.name, p.Spam, c.want, logit, threshold)
		}
	}
}

// TestSpamCorpus checks the model against real mail, which isn't in the repository:
//
//	NOUVEX_HAM=dir,mbox NOUVEX_SPAM=dir,mbox go test -run SpamCorpus ./internal/mail
//
// Wanted mail flagged is what hurts, so it may be at most 0.5% of it.
func TestSpamCorpus(t *testing.T) {
	if os.Getenv("NOUVEX_HAM") == "" && os.Getenv("NOUVEX_SPAM") == "" {
		t.Skip("NOUVEX_HAM and NOUVEX_SPAM aren't set")
	}
	share := func(env string) (flagged, total int) {
		for _, path := range strings.Split(os.Getenv(env), ",") {
			if path == "" {
				continue
			}
			msgs, err := Corpus(path)
			if err != nil {
				t.Fatal(err)
			}
			for _, raw := range msgs {
				p, err := Content(raw)
				if err != nil {
					continue
				}
				total++
				if p.Spam {
					flagged++
				}
			}
		}
		return flagged, total
	}
	if flagged, total := share("NOUVEX_HAM"); total > 0 {
		t.Logf("ham: %d of %d flagged", flagged, total)
		if float64(flagged) > 0.005*float64(total) {
			t.Errorf("%d of %d wanted messages flagged as spam", flagged, total)
		}
	}
	if flagged, total := share("NOUVEX_SPAM"); total > 0 {
		t.Logf("spam: %d of %d caught", flagged, total)
	}
}
