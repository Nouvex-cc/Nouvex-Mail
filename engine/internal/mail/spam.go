// SPDX-License-Identifier: AGPL-3.0-only

package mail

import (
	_ "embed"
	"encoding/binary"
	"hash/fnv"
	"math"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"unicode"

	"github.com/emersion/go-message/mail"
	"golang.org/x/net/publicsuffix"
)

// The spam model: naive Bayes over the words of a message, the domains it links to and a few traits of how it's built,
// trained on public corpora by engine/cmd/train. A float32 threshold, then one int8 log-odds weight (in sixteenths) per
// slot.
//
//go:embed spam.model
var spamModel []byte

// Slots is how many weights the model has; tokens share them by hash.
const Slots = 1 << 18

var (
	hrefs    = regexp.MustCompile(`(?is)<a\b[^>]*\bhref\s*=\s*["']?([^"'\s>]+)[^>]*>(.*?)</a>`)
	bareURLs = regexp.MustCompile(`https?://[^\s"'<>()]+`)
	domainIn = regexp.MustCompile(`(?i)\b([a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,})\b`)
)

// Features are the tokens the model weighs: words of the subject and text, linked domains and traits. Training and
// scoring both go through here, so they can't drift apart.
func Features(h mail.Header, subject, text, htmlPart string) []string {
	seen := map[string]bool{}
	var out []string
	add := func(t string) {
		if !seen[t] {
			seen[t] = true
			out = append(out, t)
		}
	}
	words := func(prefix, s string) {
		for _, w := range strings.FieldsFunc(strings.ToLower(s), func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) }) {
			if n := len([]rune(w)); n >= 2 && n <= 30 {
				add(prefix + w)
			}
		}
	}
	words("s:", subject)
	if r := []rune(text); len(r) > 20000 {
		text = string(r[:20000])
	}
	words("", text)
	// A link whose text names another domain than it goes to is a phishing trick.
	for _, m := range hrefs.FindAllStringSubmatch(htmlPart, 200) {
		host := hostOf(m[1])
		if host == "" {
			continue
		}
		add("u:" + host)
		if shown := domainIn.FindString(plain(m[2])); shown != "" && !sameSite(strings.ToLower(shown), host) {
			add("t:link-mismatch")
		}
	}
	for _, u := range bareURLs.FindAllString(text, 100) {
		if host := hostOf(u); host != "" {
			add("u:" + host)
		}
	}
	if htmlPart != "" && strings.TrimSpace(text) == "" {
		add("t:no-text")
	}
	from, _ := h.AddressList("From")
	reply, _ := h.AddressList("Reply-To")
	if len(from) > 0 && len(reply) > 0 && !sameSite(domainOf(reply[0].Address), domainOf(from[0].Address)) {
		add("t:reply-elsewhere")
	}
	// "PayPal <x@random.example>": the name shows an address or brand domain the mail isn't from.
	if len(from) > 0 {
		if shown := domainIn.FindString(from[0].Name); shown != "" && !sameSite(strings.ToLower(shown), domainOf(from[0].Address)) {
			add("t:name-elsewhere")
		}
	}
	return out
}

func hostOf(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return ""
	}
	return strings.TrimPrefix(strings.ToLower(u.Hostname()), "www.")
}

func domainOf(addr string) string {
	_, d, _ := strings.Cut(strings.ToLower(addr), "@")
	return d
}

// sameSite is true when one domain is the other or under it: news.example.com and example.com.
func sameSite(a, b string) bool {
	a, b = strings.TrimPrefix(a, "www."), strings.TrimPrefix(b, "www.")
	return a == b || strings.HasSuffix(a, "."+b) || strings.HasSuffix(b, "."+a)
}

// Slot is where a token's weight lives.
func Slot(token string) uint32 {
	f := fnv.New32a()
	_, _ = f.Write([]byte(token))
	return f.Sum32() % Slots
}

// SpamScore is the model's log-odds that the tokens are spam, and the threshold it was tuned to.
func SpamScore(tokens []string) (logit, threshold float64) {
	threshold = float64(math.Float32frombits(binary.LittleEndian.Uint32(spamModel)))
	for _, t := range tokens {
		logit += float64(int8(spamModel[4+Slot(t)])) / 16
	}
	return logit, threshold
}

// checked is what the user's provider found about where a mail comes from: every Authentication-Results it added.
// The topmost is the provider's; iCloud spreads its findings over several (dkim-verifier.icloud.com,
// spf.icloud.com, …), so all under the same domain count. One a sender wrote into the mail, under another name, doesn't.
func checked(h mail.Header) string {
	all := h.Values("Authentication-Results")
	if len(all) == 0 {
		return ""
	}
	site := func(r string) string {
		id, _, _ := strings.Cut(r, ";")
		if f := strings.Fields(id); len(f) > 0 {
			id = strings.ToLower(f[0])
		}
		if d, err := publicsuffix.EffectiveTLDPlusOne(id); err == nil {
			return d
		}
		return id
	}
	own := site(all[0])
	var out []string
	for _, r := range all {
		if site(r) == own {
			out = append(out, r)
		}
	}
	return strings.ToLower(strings.Join(out, ";"))
}

// signed is true when the user's provider found the mail really comes from its From domain: DMARC passed, or DKIM
// passed for that domain.
func signed(h mail.Header) bool {
	results := checked(h)
	if strings.Contains(results, "dmarc=pass") {
		return true
	}
	from, _ := h.AddressList("From")
	if len(from) == 0 {
		return false
	}
	domain := domainOf(from[0].Address)
	for _, part := range strings.Split(results, ";") {
		part = strings.TrimSpace(part)
		if !strings.HasPrefix(part, "dkim=pass") {
			continue
		}
		for _, f := range strings.Fields(part) {
			if d, ok := strings.CutPrefix(f, "header.d="); ok && sameSite(d, domain) {
				return true
			}
			if i, ok := strings.CutPrefix(f, "header.i="); ok && sameSite(domainOf(i), domain) {
				return true
			}
		}
	}
	return false
}

// spam is the engine's own verdict, and a careful one: the words alone never decide, since the corpora it learned
// from are English and old. It also takes a trick (a link or a name showing another domain), or a provider that
// checked where the mail comes from and couldn't confirm it (no DMARC, DKIM or SPF pass). Mail that proves where it's
// from is the provider's to judge: newsletters link through tracking domains all the time.
func spam(h mail.Header, tokens []string) bool {
	if logit, threshold := SpamScore(tokens); logit < threshold || signed(h) {
		return false
	}
	if slices.Contains(tokens, "t:link-mismatch") || slices.Contains(tokens, "t:name-elsewhere") {
		return true
	}
	results := checked(h)
	return results != "" && !strings.Contains(results, "spf=pass")
}
