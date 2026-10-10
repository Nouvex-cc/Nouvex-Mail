// SPDX-License-Identifier: AGPL-3.0-only

package mail

import (
	"strings"
	"testing"
	"time"

	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/msg"
)

const sample = "From: Ann <ann@example.com>\r\nSubject: hi\r\nDate: Wed, 7 Oct 2026 10:00:00 +0200\r\n\r\nbody\r\n"

func TestParse(t *testing.T) {
	h, err := Parse(strings.NewReader(sample))
	if err != nil {
		t.Fatal(err)
	}
	if h.Subject != "hi" || h.From != `"Ann" <ann@example.com>` {
		t.Fatalf("got %+v", h)
	}
}

func FuzzParse(f *testing.F) {
	f.Add(sample)
	f.Fuzz(func(t *testing.T, s string) {
		_, _ = Parse(strings.NewReader(s))
	})
}

func TestBody(t *testing.T) {
	alt := "From: a@x\r\nSubject: s\r\nMIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary=b\r\n\r\n" +
		"--b\r\nContent-Type: text/plain\r\n\r\nHello   Mateo,\r\nsee you\r\n" +
		"--b\r\nContent-Type: text/html\r\n\r\n<p>Hello <b>Mateo</b></p>\r\n--b--\r\n"
	body, snippet, _, err := Content([]byte(alt))
	if err != nil || body != "<p>Hello <b>Mateo</b></p>" || snippet != "Hello Mateo, see you" {
		t.Fatalf("%q %q %v", body, snippet, err)
	}

	plain := "From: a@x\r\nSubject: s\r\n\r\n1 < 2 & <script>\r\n"
	body, snippet, _, err = Content([]byte(plain))
	if err != nil || body != `<div style="white-space: pre-wrap">1 &lt; 2 &amp; &lt;script&gt;`+"\r\n</div>" || snippet != "1 < 2 & <script>" {
		t.Fatalf("%q %q %v", body, snippet, err)
	}

	onlyHTML := "From: a@x\r\nContent-Type: text/html\r\n\r\n<style>p{}</style><p>Hi&nbsp;there</p>"
	if _, snippet, _, _ = Content([]byte(onlyHTML)); snippet != "Hi there" {
		t.Fatalf("%q", snippet)
	}
}

func TestCompose(t *testing.T) {
	raw, err := Compose("mateo@nouvex.cc", msg.MessageSend{
		To: []string{"lena@hartmann.example"}, Cc: []string{"jonas@weber.example"}, Bcc: []string{"secret@x.example"},
		Subject: "Schlüssel für Freitag", Text: "Bis Freitag!",
	}, "parent@x.example", nil, time.Date(2026, 10, 9, 9, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	s := string(raw)
	if strings.Contains(s, "secret@x.example") {
		t.Fatal("bcc leaked into the headers")
	}
	h, err := Parse(strings.NewReader(s))
	if err != nil || h.Subject != "Schlüssel für Freitag" || h.From != "<mateo@nouvex.cc>" {
		t.Fatalf("%+v %v", h, err)
	}
	for _, want := range []string{"To: <lena@hartmann.example>", "Cc: <jonas@weber.example>", "Message-Id: <", "@nouvex.cc>", "In-Reply-To: <parent@x.example>", "References: <parent@x.example>", "Bis Freitag!"} {
		if !strings.Contains(s, want) {
			t.Fatalf("missing %q in\n%s", want, s)
		}
	}
}

func TestAttachments(t *testing.T) {
	raw := "From: a@x\r\nSubject: s\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n" +
		"--b\r\nContent-Type: text/plain\r\n\r\nSee attached\r\n" +
		"--b\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename=\"Übergabe.pdf\"\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0x\r\n" +
		"--b\r\nContent-Type: image/png\r\nContent-Disposition: inline\r\nContent-Transfer-Encoding: base64\r\n\r\niVBORw==\r\n--b--\r\n"
	_, snippet, files, err := Content([]byte(raw))
	if err != nil || snippet != "See attached" || len(files) != 2 {
		t.Fatalf("%q %d %v", snippet, len(files), err)
	}
	if f := files[0]; f.Name != "Übergabe.pdf" || f.Type != "application/pdf" || string(f.Data) != "%PDF-1" || f.Size != 6 {
		t.Fatalf("%+v", f)
	}
	if f := files[1]; f.Name != "attachment" || f.Type != "image/png" {
		t.Fatalf("%+v", f)
	}
}

func TestComposeWithFiles(t *testing.T) {
	raw, err := Compose("mateo@nouvex.cc", msg.MessageSend{To: []string{"lena@hartmann.example"}, Subject: "Contract", Text: "Attached."}, "",
		[]File{{Name: "Vertrag.pdf", Type: "application/pdf", Data: []byte("%PDF-1")}}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	// What we send has to read back the same way we read received mail.
	_, snippet, files, err := Content(raw)
	if err != nil || snippet != "Attached." || len(files) != 1 || files[0].Name != "Vertrag.pdf" || string(files[0].Data) != "%PDF-1" {
		t.Fatalf("%q %+v %v", snippet, files, err)
	}
}
