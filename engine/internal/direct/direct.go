// SPDX-License-Identifier: AGPL-3.0-only

// Package direct sends hosted mailboxes' mail from this server straight to the recipients' mail servers, signed
// with the sending domain's own DKIM key (selector nx1, the one SES signs with too), so a domain moves between the
// two without DNS changes. Bounces that come later go to the sender's own address, through our MX, like any mail.
package direct

import (
	"bytes"
	"cmp"
	"context"
	"crypto"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"slices"
	"strings"
	"time"

	"github.com/emersion/go-msgauth/dkim"
	"github.com/emersion/go-smtp"
)

// Sender sends from this server. Hostname is what it says in EHLO: the name the server's IP points back to
// (reverse DNS), or receivers trust it less. Key gives a verified domain's DKIM key, PKCS#8 in base64.
type Sender struct {
	Hostname string
	Key      func(ctx context.Context, domain string) (string, error)
}

// For tests: where a domain's mail servers are, and the port they listen on.
var (
	lookupMX = net.DefaultResolver.LookupMX
	port     = "25"
)

// Send signs a message and delivers it to each recipient's mail server, and says who took it. A recipient refused
// for good comes back as a 5xx error naming them; one to try again later (greylisting, a server that's down) as
// 4xx, which wins, so the whole send is tried again for the rest.
func (s *Sender) Send(ctx context.Context, from string, to []string, raw []byte, _ map[string]string) ([]string, error) {
	_, domain, _ := strings.Cut(from, "@")
	signed, err := s.sign(ctx, strings.ToLower(domain), raw)
	if err != nil {
		return nil, err
	}
	byDomain := map[string][]string{}
	for _, r := range to {
		_, d, _ := strings.Cut(r, "@")
		d = strings.ToLower(d)
		byDomain[d] = append(byDomain[d], r)
	}
	var sent, refused []string
	var later error
	for d, rcpts := range byDomain {
		took, failed, err := s.deliver(ctx, d, from, rcpts, signed)
		sent = append(sent, took...)
		for r, why := range failed {
			refused = append(refused, r+": "+why)
		}
		if err != nil {
			later = err
		}
	}
	if later != nil {
		return sent, later
	}
	if len(refused) > 0 {
		slices.Sort(refused)
		return sent, &smtp.SMTPError{Code: 550, EnhancedCode: smtp.EnhancedCode{5, 1, 1}, Message: strings.Join(refused, "; ")}
	}
	return sent, nil
}

func (s *Sender) sign(ctx context.Context, domain string, raw []byte) ([]byte, error) {
	b64, err := s.Key(ctx, domain)
	if err != nil {
		return nil, fmt.Errorf("the DKIM key of %s: %w", domain, err)
	}
	der, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return nil, err
	}
	key, err := x509.ParsePKCS8PrivateKey(der)
	if err != nil {
		return nil, err
	}
	signer, ok := key.(crypto.Signer)
	if !ok {
		return nil, errors.New("DKIM key can't sign")
	}
	var out bytes.Buffer
	err = dkim.Sign(&out, bytes.NewReader(raw), &dkim.SignOptions{Domain: domain, Selector: "nx1", Signer: signer})
	return out.Bytes(), err
}

// deliver hands a message to one domain's mail server, the first of its MX hosts that answers. It returns who it
// took, who it refused for good and why, and an error if the rest should be tried again later.
func (s *Sender) deliver(ctx context.Context, domain, from string, to []string, msg []byte) ([]string, map[string]string, error) {
	hosts, err := mxHosts(ctx, domain)
	if err != nil {
		return nil, nil, err
	}
	var last error
	for _, host := range hosts {
		took, refused, err := s.session(ctx, host, from, to, msg, verified)
		var cert *tls.CertificateVerificationError
		switch {
		case errors.As(err, &cert):
			// ponytail: opportunistic TLS like most servers do; MTA-STS would say when a valid certificate is a must.
			took, refused, err = s.session(ctx, host, from, to, msg, anyCert)
		case err != nil && strings.Contains(err.Error(), "doesn't support STARTTLS"):
			took, refused, err = s.session(ctx, host, from, to, msg, plain)
		}
		var se *smtp.SMTPError
		var dnsErr *net.DNSError
		switch {
		case errors.As(err, &dnsErr) && dnsErr.IsNotFound && len(hosts) == 1 && host == domain:
			return nil, nil, &smtp.SMTPError{Code: 550, EnhancedCode: smtp.EnhancedCode{5, 1, 2}, Message: domain + " doesn't exist"}
		// The server answered: what it took is gone, and the next one would say the same.
		case err == nil || len(took) > 0 || len(refused) > 0 || (errors.As(err, &se) && se.Code >= 500):
			return took, refused, err
		}
		last = err
	}
	return nil, nil, temporary(fmt.Sprintf("%s's mail servers can't be reached right now", domain), last)
}

// mxHosts is a domain's mail servers in order of preference, or the domain itself if it names none.
func mxHosts(ctx context.Context, domain string) ([]string, error) {
	mxs, err := lookupMX(ctx, domain)
	var dnsErr *net.DNSError
	if (errors.As(err, &dnsErr) && dnsErr.IsNotFound) || (err == nil && len(mxs) == 0) {
		return []string{domain}, nil
	}
	if err != nil {
		return nil, temporary("looking up "+domain+"'s mail servers failed", err)
	}
	if len(mxs) == 1 && mxs[0].Host == "." {
		return nil, &smtp.SMTPError{Code: 556, EnhancedCode: smtp.EnhancedCode{5, 1, 10}, Message: domain + " doesn't take mail"}
	}
	slices.SortStableFunc(mxs, func(a, b *net.MX) int { return cmp.Compare(a.Pref, b.Pref) })
	hosts := make([]string, len(mxs))
	for i, m := range mxs {
		hosts[i] = strings.TrimSuffix(m.Host, ".")
	}
	return hosts, nil
}

// How a session protects itself: TLS with a certificate that checks out, with any certificate, or none.
const (
	verified = iota
	anyCert
	plain
)

func (s *Sender) session(ctx context.Context, host, from string, to []string, msg []byte, security int) ([]string, map[string]string, error) {
	// IPv4 only: that's the address SPF and reverse DNS are set up for.
	conn, err := (&net.Dialer{Timeout: 30 * time.Second}).DialContext(ctx, "tcp4", net.JoinHostPort(host, port))
	if err != nil {
		return nil, nil, err
	}
	_ = conn.SetDeadline(time.Now().Add(10 * time.Minute))
	c := smtp.NewClient(conn)
	if security != plain {
		// ponytail: go-smtp says EHLO localhost before STARTTLS; receivers judge the EHLO after it, which is ours.
		//nolint:gosec // any certificate only after a valid one failed, see deliver
		if c, err = smtp.NewClientStartTLS(conn, &tls.Config{ServerName: host, InsecureSkipVerify: security == anyCert}); err != nil {
			return nil, nil, err
		}
	}
	defer func() { _ = c.Close() }()
	if err := c.Hello(s.Hostname); err != nil {
		return nil, nil, err
	}
	if err := c.Mail(from, nil); err != nil {
		return nil, nil, err
	}
	var took []string
	refused := map[string]string{}
	var later error
	for _, r := range to {
		err := c.Rcpt(r, nil)
		var se *smtp.SMTPError
		switch {
		case err == nil:
			took = append(took, r)
		case errors.As(err, &se) && se.Code >= 500:
			refused[r] = se.Message
		default:
			later = err
		}
	}
	if len(took) > 0 {
		if err := data(c, msg); err != nil {
			var se *smtp.SMTPError
			if !errors.As(err, &se) || se.Code < 500 {
				return nil, refused, err
			}
			for _, r := range took {
				refused[r] = se.Message
			}
			took = nil
		}
	}
	_ = c.Quit()
	return took, refused, later
}

func data(c *smtp.Client, msg []byte) error {
	w, err := c.Data()
	if err != nil {
		return err
	}
	if _, err := w.Write(msg); err != nil {
		return err
	}
	return w.Close()
}

func temporary(msg string, err error) error {
	if err != nil {
		msg += ": " + err.Error()
	}
	return &smtp.SMTPError{Code: 451, EnhancedCode: smtp.EnhancedCode{4, 4, 0}, Message: msg}
}
