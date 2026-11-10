// SPDX-License-Identifier: AGPL-3.0-only

package ses

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/emersion/go-smtp"
)

// fakeSES answers like SES's v2 REST API and remembers what it was asked.
type fakeSES struct {
	mu       sync.Mutex
	sends    []map[string]any
	created  map[string]any
	mailFrom map[string]any
	exists   bool
	ready    bool
	fail     string
}

func (f *fakeSES) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var body map[string]any
	_ = json.NewDecoder(r.Body).Decode(&body)
	fail := func(status int, kind string) {
		w.Header().Set("X-Amzn-ErrorType", kind)
		w.WriteHeader(status)
		_, _ = w.Write([]byte(`{"message":"` + kind + ` says no"}`))
	}
	switch {
	case r.Method == http.MethodPost && r.URL.Path == "/v2/email/outbound-emails":
		switch f.fail {
		case "throttle":
			fail(http.StatusTooManyRequests, "TooManyRequestsException")
			return
		case "reject":
			fail(http.StatusBadRequest, "MessageRejected")
			return
		}
		f.sends = append(f.sends, body)
		_, _ = w.Write([]byte(`{"MessageId":"m"}`))
	case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/v2/email/identities/"):
		if !f.exists {
			fail(http.StatusNotFound, "NotFoundException")
			return
		}
		status := "PENDING"
		if f.ready {
			status = "SUCCESS"
		}
		_, _ = w.Write([]byte(`{"VerifiedForSendingStatus":` + map[bool]string{true: "true", false: "false"}[f.ready] +
			`,"DkimAttributes":{"Status":"` + status + `"},"MailFromAttributes":{"MailFromDomainStatus":"` + status + `"}}`))
	case r.Method == http.MethodPost && r.URL.Path == "/v2/email/identities":
		f.created, f.exists = body, true
		_, _ = w.Write([]byte(`{}`))
	case r.Method == http.MethodPut && strings.HasSuffix(r.URL.Path, "/mail-from"):
		f.mailFrom = body
		_, _ = w.Write([]byte(`{}`))
	default:
		http.Error(w, r.Method+" "+r.URL.Path, http.StatusNotFound)
	}
}

func start(t *testing.T) (*Client, *fakeSES) {
	t.Setenv("AWS_ACCESS_KEY_ID", "test")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "test")
	f := &fakeSES{}
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	c, err := New(context.Background(), "eu-central-1", "nouvex", srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	return c, f
}

func TestSend(t *testing.T) {
	c, f := start(t)
	to := make([]string, 120)
	for i := range to {
		to[i] = "r@x.example"
	}
	if err := c.Send(context.Background(), "lena@louma.cc", to, []byte("Subject: hi\r\n\r\nhi"), map[string]string{"account": "a1"}); err != nil {
		t.Fatal(err)
	}
	if len(f.sends) != 3 || f.sends[0]["FromEmailAddress"] != "lena@louma.cc" || f.sends[0]["ConfigurationSetName"] != "nouvex" {
		t.Fatalf("%d sends: %v", len(f.sends), f.sends)
	}
	raw := f.sends[0]["Content"].(map[string]any)["Raw"].(map[string]any)["Data"].(string)
	if data, _ := base64.StdEncoding.DecodeString(raw); string(data) != "Subject: hi\r\n\r\nhi" {
		t.Fatalf("raw %q", raw)
	}

	for kind, want := range map[string]int{"throttle": 451, "reject": 554} {
		f.fail = kind
		var se *smtp.SMTPError
		if err := c.Send(context.Background(), "lena@louma.cc", to[:1], []byte("x"), nil); !errors.As(err, &se) || se.Code != want {
			t.Fatalf("%s: %v, want %d", kind, err, want)
		}
	}
}

func TestSetUp(t *testing.T) {
	c, f := start(t)
	k, _ := rsa.GenerateKey(rand.Reader, 2048)
	der, _ := x509.MarshalPKCS8PrivateKey(k)
	status, err := c.SetUp(context.Background(), "louma.cc", base64.StdEncoding.EncodeToString(der))
	if err != nil {
		t.Fatal(err)
	}
	if status != "waiting for DKIM and the bounce domain" {
		t.Fatalf("status %q", status)
	}
	dkim := f.created["DkimSigningAttributes"].(map[string]any)
	if dkim["DomainSigningSelector"] != "nx1" || f.mailFrom["MailFromDomain"] != "bounce.louma.cc" {
		t.Fatalf("created %v, mail from %v", f.created, f.mailFrom)
	}
	pkcs1, _ := base64.StdEncoding.DecodeString(dkim["DomainSigningPrivateKey"].(string))
	if _, err := x509.ParsePKCS1PrivateKey(pkcs1); err != nil {
		t.Fatalf("not PKCS#1: %v", err)
	}
	// Once SES has seen the records, a second call says so and creates nothing again.
	f.ready, f.created = true, nil
	if status, err := c.SetUp(context.Background(), "louma.cc", ""); err != nil || status != "ready" || f.created != nil {
		t.Fatalf("%q %v %v", status, err, f.created)
	}
}
