// SPDX-License-Identifier: AGPL-3.0-only

package seal

import (
	"bytes"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/hpke"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// The same mail sealed once, for the clients' tests to open. NOUVEX_FIXTURE=1 writes a new one.
const fixturePath = "../../../packages/sdk/src/crypto.fixture.json"

type fixture struct {
	Password       string `json:"password"`
	Email          string `json:"email"`
	AuthKey        string `json:"authKey"`
	PublicKey      []byte `json:"publicKey"`
	WrappedPrivate []byte `json:"wrappedPrivate"`
	MessageKey     []byte `json:"messageKey"`
	Meta           []byte `json:"meta"`
	Plain          string `json:"plain"`
}

// What the clients do with the password, here only to write and check the fixture.
func derive(password, email string) (auth string, enc []byte) {
	master, err := pbkdf2.Key(sha256.New, password, []byte("nouvex/"+strings.ToLower(email)), 600_000, 32)
	if err != nil {
		panic(err)
	}
	a, _ := hkdf.Key(sha256.New, master, nil, "nouvex auth", 32)
	enc, _ = hkdf.Key(sha256.New, master, nil, "nouvex enc", 32)
	return base64.RawURLEncoding.EncodeToString(a), enc
}

func open(key []byte, label string, sealed []byte) ([]byte, error) {
	gcm := aead(key)
	return gcm.Open(nil, sealed[:gcm.NonceSize()], sealed[gcm.NonceSize():], []byte(label))
}

func unwrap(private *ecdh.PrivateKey, wrapped []byte) ([]byte, error) {
	k, err := hpke.NewDHKEMPrivateKey(private)
	if err != nil {
		return nil, err
	}
	return hpke.Open(k, hpke.HKDFSHA256(), hpke.AES256GCM(), []byte(Info), wrapped)
}

func TestRoundTrip(t *testing.T) {
	private, _ := ecdh.X25519().GenerateKey(rand.Reader)
	key := NewKey()
	wrapped, err := Wrap(private.PublicKey().Bytes(), key)
	if err != nil {
		t.Fatal(err)
	}
	got, err := unwrap(private, wrapped)
	if err != nil || !bytes.Equal(got, key) {
		t.Fatalf("unwrap: %v", err)
	}
	sealed := Encrypt(key, "body", []byte("<p>hi</p>"))
	if plain, err := open(key, "body", sealed); err != nil || string(plain) != "<p>hi</p>" {
		t.Fatalf("open: %q %v", plain, err)
	}
	if _, err := open(key, "meta", sealed); err == nil {
		t.Fatal("a body opened as meta")
	}
	other, _ := ecdh.X25519().GenerateKey(rand.Reader)
	if _, err := unwrap(other, wrapped); err == nil {
		t.Fatal("someone else's key opened it")
	}
}

func TestFixture(t *testing.T) {
	if os.Getenv("NOUVEX_FIXTURE") == "1" {
		writeFixture(t)
	}
	raw, err := os.ReadFile(fixturePath)
	if err != nil {
		t.Fatal(err)
	}
	var f fixture
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	auth, enc := derive(f.Password, f.Email)
	if auth != f.AuthKey {
		t.Fatalf("authKey %s, want %s", auth, f.AuthKey)
	}
	priv, err := open(enc, "nouvex private key", f.WrappedPrivate)
	if err != nil {
		t.Fatal(err)
	}
	private, _ := ecdh.X25519().NewPrivateKey(priv)
	key, err := unwrap(private, f.MessageKey)
	if err != nil {
		t.Fatal(err)
	}
	if meta, err := open(key, "meta", f.Meta); err != nil || string(meta) != f.Plain {
		t.Fatalf("meta %q %v", meta, err)
	}
}

func writeFixture(t *testing.T) {
	f := fixture{Password: "correct horse battery staple", Email: "Anim@Nouvex.test", Plain: `{"subject":"Grüße aus Köln"}`}
	var enc []byte
	f.AuthKey, enc = derive(f.Password, f.Email)
	private, _ := ecdh.X25519().GenerateKey(rand.Reader)
	f.PublicKey = private.PublicKey().Bytes()
	f.WrappedPrivate = Encrypt(enc, "nouvex private key", private.Bytes())
	key := NewKey()
	var err error
	if f.MessageKey, err = Wrap(f.PublicKey, key); err != nil {
		t.Fatal(err)
	}
	f.Meta = Encrypt(key, "meta", []byte(f.Plain))
	out, _ := json.MarshalIndent(f, "", "\t")
	if err := os.WriteFile(fixturePath, append(out, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
}
