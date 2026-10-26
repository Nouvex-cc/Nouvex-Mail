// SPDX-License-Identifier: AGPL-3.0-only

package mail

import (
	"bufio"
	"encoding/base64"
	"net"
	"strings"
	"testing"

	"github.com/emersion/go-imap/v2"
)

// gmail answers like Gmail does, for one user and two tabs.
func gmail(t *testing.T, conn net.Conn) {
	defer func() { _ = conn.Close() }()
	r := bufio.NewReader(conn)
	say := func(s string) { _, _ = conn.Write([]byte(s + "\r\n")) }
	say("* OK Gimap ready")
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			return
		}
		cmd := strings.TrimSpace(strings.TrimPrefix(line, "x "))
		switch {
		case strings.HasPrefix(cmd, "AUTHENTICATE PLAIN "):
			plain, _ := base64.StdEncoding.DecodeString(strings.TrimPrefix(cmd, "AUTHENTICATE PLAIN "))
			if string(plain) != "\x00max@gmail.com\x00app pass" {
				say("x NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)")
				continue
			}
			say("x OK max@gmail.com authenticated (Success)")
		case cmd == "EXAMINE INBOX":
			say("* 5 EXISTS")
			say("x OK [READ-ONLY] INBOX selected. (Success)")
		case cmd == `UID SEARCH X-GM-RAW "category:promotions"`:
			say("* SEARCH 3 7")
			say("x OK SEARCH completed (Success)")
		case cmd == `UID SEARCH X-GM-RAW "category:updates"`:
			say("* SEARCH 9")
			say("x OK SEARCH completed (Success)")
		case strings.HasPrefix(cmd, "UID SEARCH"):
			say("* SEARCH")
			say("x OK SEARCH completed (Success)")
		case cmd == "LOGOUT":
			say("* BYE LOGOUT Requested")
			say("x OK 73 good day (Success)")
			return
		default:
			t.Errorf("unexpected %q", cmd)
			say("x BAD")
		}
	}
}

func TestGmailTabs(t *testing.T) {
	client, server := net.Pipe()
	go gmail(t, server)
	tabs, err := askTabs(client, "max@gmail.com", "app pass")
	if err != nil {
		t.Fatal(err)
	}
	want := map[imap.UID]int{3: 1, 7: 1, 9: 3}
	if len(tabs) != len(want) {
		t.Fatalf("%v", tabs)
	}
	for uid, label := range want {
		if tabs[uid] != label {
			t.Errorf("UID %d: %s, want %s", uid, Labels[tabs[uid]], Labels[label])
		}
	}

	client, server = net.Pipe()
	go gmail(t, server)
	_, err = askTabs(client, "max@gmail.com", "wrong pass")
	if err == nil || strings.Contains(err.Error(), "wrong pass") {
		t.Fatalf("a wrong password: %v", err)
	}
}
