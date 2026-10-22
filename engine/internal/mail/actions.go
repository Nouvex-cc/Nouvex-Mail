// SPDX-License-Identifier: AGPL-3.0-only

package mail

import (
	"cmp"
	"regexp"
	"strings"
	"time"

	// Invitations name their time zone; the engine image may not ship zoneinfo.
	_ "time/tzdata"
)

// Action is something a message lets you do right away: copy a sign-in code or join a meeting. Clients decide
// how long it stays useful.
type Action struct {
	Kind     string     `json:"kind"` // "code" or "meeting"
	Code     string     `json:"code,omitempty"`
	Title    string     `json:"title,omitempty"`
	Start    *time.Time `json:"start,omitempty"`
	End      *time.Time `json:"end,omitempty"`
	URL      string     `json:"url,omitempty"`
	Provider string     `json:"provider,omitempty"`
	// The invitation's UID: updates and cancellations of one meeting share it.
	Event     string `json:"event,omitempty"`
	Cancelled bool   `json:"cancelled,omitempty"`
}

var (
	// German words are listed whole: "Sicherheitscode" has no word boundary before "code".
	codeWord   = regexp.MustCompile(`(?i)\b(code|verification|verify|otp|one[- ]time|passcode|2fa|two[- ]factor|sign[- ]in|log[- ]?in|bestätigungscode|sicherheitscode|anmeldecode|einmalcode|verifizierungscode|zugangscode|tan)\b`)
	codeDigits = regexp.MustCompile(`\b(\d{3}[ -]\d{3}|\d{4,8})\b`)
	// Only links of known meeting services get a Join button; any other link in a mail could lead anywhere.
	meetingURL = regexp.MustCompile(`https://([\w-]+\.)*(zoom\.us|meet\.google\.com|teams\.microsoft\.com|teams\.live\.com|webex\.com)/[^\s"'<>\\]+`)
	// ponytail: the zones Outlook and Teams invitations use most; others aren't shown, mapping them needs CLDR data.
	windowsZones = map[string]string{
		"W. Europe Standard Time":        "Europe/Berlin",
		"Central Europe Standard Time":   "Europe/Budapest",
		"Romance Standard Time":          "Europe/Paris",
		"GMT Standard Time":              "Europe/London",
		"Eastern Standard Time":          "America/New_York",
		"Central Standard Time":          "America/Chicago",
		"Pacific Standard Time":          "America/Los_Angeles",
		"UTC":                            "UTC",
		"Coordinated Universal Time":     "UTC",
		"E. Europe Standard Time":        "Europe/Bucharest",
		"Central European Standard Time": "Europe/Warsaw",
	}
)

func actions(subject, text, calendar string) []Action {
	// An invitation's passcode isn't a sign-in code.
	if m := meeting(calendar); m != nil {
		return []Action{*m}
	}
	if c := code(subject, text); c != "" {
		return []Action{{Kind: "code", Code: c}}
	}
	return nil
}

// code finds a sign-in code: digits shortly after a word like "code" ("Your code: 483920"), or just before it
// ("483920 is your code"). Only the subject and the top of the text count; further down, numbers are mostly
// addresses, dates and order numbers.
func code(subject, text string) string {
	if r := []rune(text); len(r) > 600 {
		text = string(r[:600])
	}
	for _, s := range []string{subject, text} {
		words := codeWord.FindAllStringIndex(s, -1)
		for _, d := range codeDigits.FindAllStringIndex(s, -1) {
			m := s[d[0]:d[1]]
			if len(m) == 4 && (strings.HasPrefix(m, "19") || strings.HasPrefix(m, "20")) {
				continue // a year
			}
			for _, w := range words {
				if (d[0] >= w[1] && d[0]-w[1] <= 60) || (d[1] <= w[0] && w[0]-d[1] <= 25) {
					return strings.NewReplacer(" ", "", "-", "").Replace(m)
				}
			}
		}
	}
	return ""
}

// meeting reads the first event of an iCalendar invitation. Without a start time there's nothing to count down to.
// ponytail: a repeating meeting shows its first date only; following RRULE needs a recurrence library.
func meeting(ics string) *Action {
	if ics == "" {
		return nil
	}
	ics = strings.NewReplacer("\r\n ", "", "\r\n\t", "", "\n ", "", "\n\t", "").Replace(ics)
	a := Action{Kind: "meeting"}
	var in bool
	var text strings.Builder
	for line := range strings.Lines(ics) {
		name, value, ok := strings.Cut(strings.TrimRight(line, "\r\n"), ":")
		if !ok {
			continue
		}
		key, params, _ := strings.Cut(name, ";")
		switch strings.ToUpper(key) {
		case "METHOD":
			a.Cancelled = a.Cancelled || strings.EqualFold(value, "CANCEL")
		case "BEGIN":
			// An alarm inside the event doesn't end it.
			in = in || strings.EqualFold(value, "VEVENT")
		case "END":
			if strings.EqualFold(value, "VEVENT") && in {
				return found(a, text.String())
			}
		}
		if !in {
			continue
		}
		switch strings.ToUpper(key) {
		case "UID":
			a.Event = value
		case "SUMMARY":
			a.Title = unescape(value)
		case "DTSTART":
			a.Start = icsTime(params, value)
		case "DTEND":
			a.End = icsTime(params, value)
		case "STATUS":
			a.Cancelled = a.Cancelled || strings.EqualFold(value, "CANCELLED")
		}
		// The link can be in the location, the description or a vendor property.
		text.WriteString(value + " ")
	}
	return found(a, text.String())
}

func found(a Action, text string) *Action {
	if a.Start == nil {
		return nil
	}
	if a.URL = meetingURL.FindString(unescape(text)); a.URL != "" {
		a.Provider = provider(a.URL)
	}
	return &a
}

func icsTime(params, v string) *time.Time {
	loc := time.UTC
	for p := range strings.SplitSeq(params, ";") {
		if tz, ok := strings.CutPrefix(p, "TZID="); ok {
			tz = strings.Trim(tz, `"`)
			l, err := time.LoadLocation(cmp.Or(windowsZones[tz], tz))
			if err != nil {
				return nil
			}
			loc = l
		}
	}
	if utc, ok := strings.CutSuffix(v, "Z"); ok {
		v, loc = utc, time.UTC
	}
	// An all-day event (VALUE=DATE) has no time and fails here too.
	t, err := time.ParseInLocation("20060102T150405", v, loc)
	if err != nil {
		return nil
	}
	return &t
}

func provider(url string) string {
	switch {
	case strings.Contains(url, "zoom.us"):
		return "Zoom"
	case strings.Contains(url, "meet.google.com"):
		return "Google Meet"
	case strings.Contains(url, "teams."):
		return "Teams"
	default:
		return "Webex"
	}
}

func unescape(s string) string {
	return strings.NewReplacer(`\n`, " ", `\N`, " ", `\,`, ",", `\;`, ";", `\\`, `\`).Replace(s)
}
