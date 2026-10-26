// SPDX-License-Identifier: AGPL-3.0-only

package mail

import (
	"bufio"
	"crypto/tls"
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"time"

	"github.com/emersion/go-imap/v2"
)

// tabLabels are Gmail's inbox tabs by the label each is: what sorting learns from on Gmail accounts.
var tabLabels = map[string]int{"primary": 0, "promotions": 1, "social": 2, "updates": 3}

// gmailTabs asks Gmail which tab it put each inbox message in, by UID. go-imap can't send X-GM-RAW searches, so
// this speaks the few commands it needs on a connection of its own.
func gmailTabs(host string, port int, user, pass string) (map[imap.UID]int, error) {
	conn, err := tls.Dial("tcp", net.JoinHostPort(host, strconv.Itoa(port)), tlsConfig(host))
	if err != nil {
		return nil, err
	}
	defer func() { _ = conn.Close() }()
	_ = conn.SetDeadline(time.Now().Add(2 * time.Minute))
	return askTabs(conn, user, pass)
}

func askTabs(conn io.ReadWriter, user, pass string) (map[imap.UID]int, error) {
	r := bufio.NewReader(conn)
	if _, err := r.ReadString('\n'); err != nil {
		return nil, err
	}
	// The untagged lines before the command's OK. Errors carry the server's answer, never the command: the login
	// is in one.
	run := func(cmd string) ([]string, error) {
		if _, err := fmt.Fprintf(conn, "x %s\r\n", cmd); err != nil {
			return nil, err
		}
		var lines []string
		for {
			line, err := r.ReadString('\n')
			if err != nil {
				return nil, err
			}
			line = strings.TrimRight(line, "\r\n")
			if done, ok := strings.CutPrefix(line, "x "); ok {
				if !strings.HasPrefix(done, "OK") {
					return nil, fmt.Errorf("gmail: %s", done)
				}
				return lines, nil
			}
			lines = append(lines, line)
		}
	}
	if _, err := run("AUTHENTICATE PLAIN " + base64.StdEncoding.EncodeToString([]byte("\x00"+user+"\x00"+pass))); err != nil {
		return nil, err
	}
	if _, err := run("EXAMINE INBOX"); err != nil {
		return nil, err
	}
	tabs := map[imap.UID]int{}
	for tab, label := range tabLabels {
		lines, err := run(`UID SEARCH X-GM-RAW "category:` + tab + `"`)
		if err != nil {
			return nil, err
		}
		for _, line := range lines {
			found, ok := strings.CutPrefix(line, "* SEARCH")
			if !ok {
				continue
			}
			for f := range strings.FieldsSeq(found) {
				if uid, err := strconv.ParseUint(f, 10, 32); err == nil {
					tabs[imap.UID(uid)] = label
				}
			}
		}
	}
	_, _ = run("LOGOUT")
	return tabs, nil
}
