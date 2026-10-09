// SPDX-License-Identifier: AGPL-3.0-only

// Package secret opens secrets sealed by apps/api/src/secret.ts.
package secret

import (
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"errors"
	"os"
)

// Key reads the master key from SECRETS_KEY.
func Key() ([]byte, error) {
	k, err := base64.StdEncoding.DecodeString(os.Getenv("SECRETS_KEY"))
	if err != nil || len(k) != 32 {
		return nil, errors.New("SECRETS_KEY must be 32 bytes, base64")
	}
	return k, nil
}

func Open(master, sealed []byte) (string, error) {
	// version, nonce, data key + tag, nonce, at least a tag
	if len(sealed) < 1+12+48+12+16 || sealed[0] != 1 {
		return "", errors.New("unknown secret format")
	}
	dataKey, err := open(master, sealed[1:13], sealed[13:61])
	if err != nil {
		return "", err
	}
	plain, err := open(dataKey, sealed[61:73], sealed[73:])
	return string(plain), err
}

func open(key, nonce, sealed []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return gcm.Open(nil, nonce, sealed, nil)
}
