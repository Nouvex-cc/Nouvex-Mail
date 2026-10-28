// SPDX-License-Identifier: AGPL-3.0-only

package mail

import (
	"strings"

	"github.com/emersion/go-message/mail"
)

// signed is true when the receiving server found the mail really comes from its From domain: DMARC passed, or DKIM
// passed for that domain. Only the topmost Authentication-Results counts; that's the one the user's provider added.
func signed(h mail.Header) bool {
	results := strings.ToLower(h.Get("Authentication-Results"))
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

func domainOf(addr string) string {
	_, d, _ := strings.Cut(strings.ToLower(addr), "@")
	return d
}

// sameSite is true when one domain is the other or under it: news.example.com and example.com.
func sameSite(a, b string) bool {
	a, b = strings.TrimPrefix(a, "www."), strings.TrimPrefix(b, "www.")
	return a == b || strings.HasSuffix(a, "."+b) || strings.HasSuffix(b, "."+a)
}
