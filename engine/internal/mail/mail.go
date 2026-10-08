// SPDX-License-Identifier: AGPL-3.0-only

// Package mail talks to IMAP/SMTP servers and parses what comes back.
package mail

import (
	"bytes"
	"io"
	"strings"

	"github.com/emersion/go-imap/v2/imapclient"
	"github.com/emersion/go-message/mail"
	"github.com/emersion/go-msgauth/dkim"
	"github.com/emersion/go-sasl"
	"github.com/emersion/go-smtp"
)

type Header struct {
	Subject string
	From    string
	Date    string
}

func Parse(r io.Reader) (*Header, error) {
	mr, err := mail.CreateReader(r)
	if err != nil {
		return nil, err
	}
	defer func() { _ = mr.Close() }()
	subject, _ := mr.Header.Subject()
	from, _ := mr.Header.AddressList("From")
	addrs := make([]string, len(from))
	for i, a := range from {
		addrs[i] = a.String()
	}
	return &Header{Subject: subject, From: strings.Join(addrs, ", "), Date: mr.Header.Get("Date")}, nil
}

// DKIMValid is true only if the message carries signatures and all of them verify.
func DKIMValid(raw []byte) bool {
	vs, err := dkim.Verify(bytes.NewReader(raw))
	if err != nil || len(vs) == 0 {
		return false
	}
	for _, v := range vs {
		if v.Err != nil {
			return false
		}
	}
	return true
}

func DialIMAP(addr, user, pass string) (*imapclient.Client, error) {
	c, err := imapclient.DialTLS(addr, nil)
	if err != nil {
		return nil, err
	}
	if err := c.Login(user, pass).Wait(); err != nil {
		_ = c.Close()
		return nil, err
	}
	return c, nil
}

func Send(addr, user, pass, from string, to []string, msg io.Reader) error {
	return smtp.SendMail(addr, sasl.NewPlainClient("", user, pass), from, to, msg)
}
