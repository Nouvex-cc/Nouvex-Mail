// SPDX-License-Identifier: AGPL-3.0-only

package mail

import (
	"strings"
	"testing"
	"time"
)

func TestCode(t *testing.T) {
	for _, c := range []struct{ subject, text, want string }{
		{"Your GitHub launch code", "Here is your GitHub launch code: 48291037. Continue signing in.", "48291037"},
		{"483920 is your verification code", "Don't share it.", "483920"},
		{"Anmeldung", "Ihr Bestätigungscode lautet 123 456. Er ist 10 Minuten gültig.", "123456"},
		{"Sign in to Acme", "Use 771-204 to sign in.", "771204"},
		{"Ihr Sicherheitscode", "Code: 9182 (gültig bis 2026)", "9182"},
		{"Order shipped", "Your order 12345678 is on its way.", ""},
		{"959054 is your X verification code", "Confirm https://x.com/i/verify?session_token=&amp;verification_code=959054", "959054"},
		{"Dein Score hat sich geändert", strings.Repeat("Neuigkeiten für dich. ", 30) + "Login · Musterstraße 1, 4889 Ort", ""},
		{"Sale", "Use code SPRING20 at checkout, valid until 2026.", ""},
	} {
		got := ""
		if a := actions(c.subject, c.text, ""); len(a) == 1 {
			got = a[0].Code
		}
		if got != c.want {
			t.Errorf("%q: got %q, want %q", c.subject, got, c.want)
		}
	}
}

const invite = "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VTIMEZONE\r\nTZID:W. Europe Standard Time\r\nBEGIN:STANDARD\r\n" +
	"DTSTART:16010101T030000\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\nBEGIN:VEVENT\r\nUID:abc-1\r\nSUMMARY:Weekly sync\\, team\r\n" +
	"DTSTART;TZID=W. Europe Standard Time:20261015T150000\r\nDTEND;TZID=W. Europe Standard Time:20261015T153000\r\n" +
	"BEGIN:VALARM\r\nTRIGGER:-PT15M\r\nEND:VALARM\r\n" +
	"X-MICROSOFT-SKYPETEAMSMEETINGURL:https://teams.microsoft.com/l/meetup-join/19%3ameeting_x/0?context=%7b%7\r\n d\r\n" +
	"DESCRIPTION:Join with passcode 123456\\nhttps://evil.example/login\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"

func TestMeeting(t *testing.T) {
	a := actions("Invitation: Weekly sync", "Passcode 123456", invite)
	if len(a) != 1 || a[0].Kind != "meeting" {
		t.Fatalf("%+v", a)
	}
	m := a[0]
	berlin, _ := time.LoadLocation("Europe/Berlin")
	if m.Title != "Weekly sync, team" || m.Event != "abc-1" || m.Provider != "Teams" || m.Cancelled ||
		!m.Start.Equal(time.Date(2026, 10, 15, 15, 0, 0, 0, berlin)) || !m.End.Equal(m.Start.Add(30*time.Minute)) ||
		m.URL != "https://teams.microsoft.com/l/meetup-join/19%3ameeting_x/0?context=%7b%7d" {
		t.Fatalf("%+v", m)
	}

	if m := meeting("METHOD:CANCEL\r\nBEGIN:VEVENT\r\nUID:abc-1\r\nDTSTART:20261015T130000Z\r\nEND:VEVENT\r\n"); m == nil || !m.Cancelled || m.URL != "" {
		t.Fatalf("%+v", m)
	}
	// All day: nothing to count down to.
	if m := meeting("BEGIN:VEVENT\r\nDTSTART;VALUE=DATE:20261015\r\nEND:VEVENT\r\n"); m != nil {
		t.Fatalf("%+v", m)
	}
}
