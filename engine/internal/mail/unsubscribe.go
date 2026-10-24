// SPDX-License-Identifier: AGPL-3.0-only

package mail

import (
	"strings"

	"github.com/emersion/go-message/mail"
)

// Unsubscribe is how a list lets you leave it (RFC 2369): a link, an address to write to, and whether the link takes a
// single POST without asking anything (RFC 8058).
type Unsubscribe struct {
	URL      string `json:"url,omitempty"`
	Mailto   string `json:"mailto,omitempty"`
	OneClick bool   `json:"oneClick,omitempty"`
}

func unsubscribe(h mail.Header) *Unsubscribe {
	var u Unsubscribe
	for _, part := range strings.Split(h.Get("List-Unsubscribe"), ",") {
		v := strings.Trim(strings.TrimSpace(part), "<>")
		switch {
		case u.URL == "" && strings.HasPrefix(strings.ToLower(v), "https://"):
			u.URL = v
		case u.Mailto == "" && strings.HasPrefix(strings.ToLower(v), "mailto:"):
			u.Mailto = v
		}
	}
	if u.URL == "" && u.Mailto == "" {
		return nil
	}
	u.OneClick = u.URL != "" && strings.Contains(strings.ToLower(h.Get("List-Unsubscribe-Post")), "list-unsubscribe=one-click")
	return &u
}
