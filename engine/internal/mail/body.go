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

// File is an attachment of a message.
type File struct {
	Name string `json:"name"`
	Type string `json:"type"`
	Size int    `json:"size"`
	Data []byte `json:"-"`
}

// Content returns the HTML to show for a raw message (the text part, escaped, if there is no HTML part), a one-line
// snippet of its text and its attachments. Sanitizing happens where it is shown.
// ponytail: inline images referenced by cid: become plain attachments; showing them in place needs cid rewriting.
func Content(raw []byte) (body, snippet string, files []File, err error) {
	mr, err := mail.CreateReader(bytes.NewReader(raw))
	if err != nil {
		return "", "", nil, err
	}
	defer func() { _ = mr.Close() }()
	var htmlPart, textPart string
	for {
		p, err := mr.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return "", "", nil, err
		}
		b, err := io.ReadAll(p.Body)
		if err != nil {
			return "", "", nil, err
		}
		var ct, name string
		switch h := p.Header.(type) {
		case *mail.InlineHeader:
			ct, _, _ = h.ContentType()
			if _, params, err := h.ContentDisposition(); err == nil {
				name = params["filename"]
			}
		case *mail.AttachmentHeader:
			ct, _, _ = h.ContentType()
			name, _ = h.Filename()
		}
		switch {
		case name == "" && ct == "text/html" && htmlPart == "":
			htmlPart = string(b)
		case name == "" && (ct == "text/plain" || ct == "") && textPart == "":
			textPart = string(b)
		case name != "" || !strings.HasPrefix(ct, "text/"):
			if name == "" {
				name = "attachment"
			}
			files = append(files, File{Name: name, Type: ct, Size: len(b), Data: b})
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
	return body, snippet, files, nil
}
