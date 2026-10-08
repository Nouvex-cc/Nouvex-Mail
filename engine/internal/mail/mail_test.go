// SPDX-License-Identifier: AGPL-3.0-only

package mail

import (
	"strings"
	"testing"
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
