// SPDX-License-Identifier: AGPL-3.0-only

package mail

import (
	"encoding/base64"

	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/msg"
	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/secret"
)

// Check logs in to IMAP and SMTP with settings that aren't saved yet.
func Check(master []byte, req msg.AccountCheck) error {
	sealed, err := base64.StdEncoding.DecodeString(req.Secret)
	if err != nil {
		return err
	}
	pass, err := secret.Open(master, sealed)
	if err != nil {
		return err
	}
	c, err := DialIMAP(req.ImapHost, req.ImapPort, req.Username, pass, nil)
	if err != nil {
		return err
	}
	_ = c.Logout().Wait()
	s, err := DialSMTP(req.SmtpHost, req.SmtpPort, req.Username, pass)
	if err != nil {
		return err
	}
	return s.Quit()
}
