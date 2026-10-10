// SPDX-License-Identifier: AGPL-3.0-only

package mail

import (
	"bytes"
	"errors"
	"html"
	"io"
	"regexp"
	"strings"

	"github.com/emersion/go-message/mail"
)

var (
	tags   = regexp.MustCompile(`(?s)<(style|script|head)\b.*?</(style|script|head)>|<[^>]*>`)
	spaces = regexp.MustCompile(`\s+`)
)

// Body returns the HTML to show for a raw message (the text part, escaped, if there is no HTML part) and a
// one-line snippet of its text. Sanitizing happens where it is shown.
func Body(raw []byte) (body, snippet string, err error) {
	mr, err := mail.CreateReader(bytes.NewReader(raw))
	if err != nil {
		return "", "", err
	}
	defer func() { _ = mr.Close() }()
	var htmlPart, textPart string
	for {
		p, err := mr.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return "", "", err
		}
		h, ok := p.Header.(*mail.InlineHeader)
		if !ok {
			continue
		}
		ct, _, _ := h.ContentType()
		b, err := io.ReadAll(p.Body)
		if err != nil {
			return "", "", err
		}
		switch {
		case ct == "text/html" && htmlPart == "":
			htmlPart = string(b)
		case ct == "text/plain" && textPart == "":
			textPart = string(b)
		}
	}
	text := textPart
	if text == "" {
		text = html.UnescapeString(tags.ReplaceAllString(htmlPart, " "))
	}
	snippet = strings.TrimSpace(spaces.ReplaceAllString(text, " "))
	if r := []rune(snippet); len(r) > 200 {
		snippet = string(r[:200])
	}
	body = htmlPart
	if body == "" {
		body = `<div style="white-space: pre-wrap">` + html.EscapeString(textPart) + `</div>`
	}
	return body, snippet, nil
}
