// SPDX-License-Identifier: AGPL-3.0-only

package direct

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"errors"
	"io"
	"math/big"
	"net"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/emersion/go-msgauth/dkim"
	"github.com/emersion/go-smtp"
)

// receiver is a mail server that takes everyone but nobody@ (refused for good) and later@ (greylisted).
type receiver struct {
	mu   sync.Mutex
	helo []string
	got  map[string][]byte
}

func (r *receiver) NewSession(c *smtp.Conn) (smtp.Session, error) {
	r.mu.Lock()
	r.helo = append(r.helo, c.Hostname())
	r.mu.Unlock()
	return &session{r: r, c: c}, nil
}

type session struct {
	r  *receiver
	c  *smtp.Conn
	to []string
}

func (s *session) Mail(string, *smtp.MailOptions) error { return nil }
func (s *session) Rcpt(to string, _ *smtp.RcptOptions) error {
	switch strings.Split(to, "@")[0] {
	case "nobody":
		return &smtp.SMTPError{Code: 550, Message: "no such user"}
	case "later":
		return &smtp.SMTPError{Code: 451, Message: "greylisted"}
	}
	s.to = append(s.to, to)
	return nil
}
func (s *session) Data(r io.Reader) error {
	b, _ := io.ReadAll(r)
	if _, ok := s.c.TLSConnectionState(); !ok {
		return &smtp.SMTPError{Code: 530, Message: "TLS first"}
	}
	s.r.mu.Lock()
	defer s.r.mu.Unlock()
	for _, to := range s.to {
		s.r.got[to] = b
	}
	return nil
}
func (s *session) Reset()        { s.to = nil }
func (s *session) Logout() error { return nil }

func TestSend(t *testing.T) {
	r := &receiver{got: map[string][]byte{}}
	srv := smtp.NewServer(r)
	srv.Domain = "mx.example"
	// STARTTLS with a certificate that doesn't check out, like many mail servers have.
	ca, _ := rsa.GenerateKey(rand.Reader, 2048)
	cert, _ := x509.CreateCertificate(rand.Reader, &x509.Certificate{SerialNumber: big.NewInt(1), DNSNames: []string{"mx.example"},
		NotAfter: time.Now().Add(time.Hour)}, &x509.Certificate{SerialNumber: big.NewInt(1)}, &ca.PublicKey, ca)
	srv.TLSConfig = &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{cert}, PrivateKey: ca}}}
	l, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = srv.Serve(l) }()
	t.Cleanup(func() { _ = srv.Close() })
	_, port, _ = net.SplitHostPort(l.Addr().String())
	t.Cleanup(func() { port = "25" })
	// a.example and b.example have a mail server, here; gone.example none that answers.
	lookupMX = func(_ context.Context, domain string) ([]*net.MX, error) {
		if domain == "gone.example" {
			return []*net.MX{{Host: "mx.gone.invalid.", Pref: 10}}, nil
		}
		return []*net.MX{{Host: "127.0.0.1.", Pref: 10}}, nil
	}
	t.Cleanup(func() { lookupMX = net.DefaultResolver.LookupMX })

	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	der, _ := x509.MarshalPKCS8PrivateKey(key)
	s := &Sender{Hostname: "mx.nouvex.test", Key: func(_ context.Context, domain string) (string, error) {
		if domain != "lena.test" {
			return "", errors.New("not ours")
		}
		return base64.StdEncoding.EncodeToString(der), nil
	}}
	raw := []byte("From: Lena <lena@lena.test>\r\nTo: tom@a.example\r\nSubject: Drafts\r\n\r\nHi Tom\r\n")
	ctx := context.Background()

	took, err := s.Send(ctx, "lena@lena.test", []string{"tom@a.example", "ann@b.example", "nobody@a.example"}, raw, nil)
	var se *smtp.SMTPError
	if slices.Sort(took); !slices.Equal(took, []string{"ann@b.example", "tom@a.example"}) || !errors.As(err, &se) || se.Code != 550 ||
		!strings.Contains(se.Message, "nobody@a.example") {
		t.Fatalf("took %v, %v", took, err)
	}
	// Signed for the sender's domain, and it checks out against the key in DNS.
	pub, _ := x509.MarshalPKIXPublicKey(&key.PublicKey)
	v, err := dkim.VerifyWithOptions(bytes.NewReader(r.got["tom@a.example"]), &dkim.VerifyOptions{
		LookupTXT: func(name string) ([]string, error) {
			if name != "nx1._domainkey.lena.test" {
				return nil, errors.New("asked for " + name)
			}
			return []string{"v=DKIM1; k=rsa; p=" + base64.StdEncoding.EncodeToString(pub)}, nil
		},
	})
	if err != nil || len(v) != 1 || v[0].Err != nil || v[0].Domain != "lena.test" {
		t.Fatalf("dkim %+v %v", v, err)
	}
	// Before STARTTLS go-smtp says localhost; after it, our name.
	if !slices.Contains(r.helo, "mx.nouvex.test") {
		t.Fatalf("said hello as %v", r.helo)
	}

	// Greylisted or not answering: try again later, and who took it is still said.
	for _, to := range [][]string{{"later@a.example", "max@b.example"}, {"x@gone.example", "max@b.example"}} {
		took, err = s.Send(ctx, "lena@lena.test", to, raw, nil)
		if !errors.As(err, &se) || se.Code != 451 || !slices.Equal(took, []string{"max@b.example"}) {
			t.Fatalf("%v: took %v, %v", to, took, err)
		}
	}

	// A domain that isn't ours doesn't send.
	if _, err := s.Send(ctx, "x@other.test", []string{"tom@a.example"}, raw, nil); err == nil {
		t.Fatal("sent without a key")
	}
}
