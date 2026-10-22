// SPDX-License-Identifier: AGPL-3.0-only

package mail

import (
	"bytes"
	"errors"
	"html"
	"io"
	"regexp"
	"strings"

	// Registers the charsets besides UTF-8 (Latin-1, Windows-1252, ...); without it such mails come out empty.
	_ "github.com/emersion/go-message/charset"
	"github.com/emersion/go-message/mail"
)

var (
	tags   = regexp.MustCompile(`(?s)<(style|script|head)\b.*?</(style|script|head)>|<[^>]*>`)
	spaces = regexp.MustCompile(`\s+`)
	// Some senders put a whole HTML page in the text part, or escape it inside the HTML part.
	markup = regexp.MustCompile(`(?i)^\s*<(!doctype|html|head|body|div|table|p|span|meta)\b`)
)

// plain is the readable text of HTML, unescaped once more if that turned out to be HTML too.
func plain(s string) string {
	s = html.UnescapeString(tags.ReplaceAllString(s, " "))
	if markup.MatchString(s) {
		s = html.UnescapeString(tags.ReplaceAllString(s, " "))
	}
	return s
}

// File is an attachment of a message.
type File struct {
	Name string `json:"name"`
	Type string `json:"type"`
	Size int    `json:"size"`
	Data []byte `json:"-"`
}

// Parsed is what a raw message shows: the HTML to render (the text part, escaped, if there is no HTML part), a
// one-line snippet of its text, its attachments, what can be done with it right away and its inbox tab.
type Parsed struct {
	Body     string
	Snippet  string
	Files    []File
	Actions  []Action
	Category string
}

// Content reads a raw message. Sanitizing happens where it is shown.
// ponytail: inline images referenced by cid: become plain attachments; showing them in place needs cid rewriting.
func Content(raw []byte) (Parsed, error) {
	mr, err := mail.CreateReader(bytes.NewReader(raw))
	if err != nil {
		return Parsed{}, err
	}
	defer func() { _ = mr.Close() }()
	var out Parsed
	var htmlPart, textPart, calendar string
	for {
		p, err := mr.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return Parsed{}, err
		}
		// Senders get the encoding wrong now and then (a stray "=" in quoted-printable); like other mail apps, keep
		// what could be read instead of losing the whole message.
		b, _ := io.ReadAll(p.Body)
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
		if calendar == "" && (ct == "text/calendar" || ct == "application/ics" || strings.HasSuffix(strings.ToLower(name), ".ics")) {
			calendar = string(b)
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
			out.Files = append(out.Files, File{Name: name, Type: ct, Size: len(b), Data: b})
		}
	}
	if markup.MatchString(textPart) {
		if htmlPart == "" {
			htmlPart = textPart
		}
		textPart = ""
	}
	text := textPart
	if text == "" {
		text = plain(htmlPart)
	}
	text = strings.TrimSpace(spaces.ReplaceAllString(text, " "))
	out.Snippet = text
	if r := []rune(text); len(r) > 200 {
		out.Snippet = string(r[:200])
	}
	out.Body = htmlPart
	if out.Body == "" {
		out.Body = `<div style="white-space: pre-wrap">` + html.EscapeString(textPart) + `</div>`
	}
	subject, _ := mr.Header.Subject()
	out.Actions = actions(subject, text, calendar)
	out.Category = category(mr.Header, subject, out.Actions)
	return out, nil
}
