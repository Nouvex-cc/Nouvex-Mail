// SPDX-License-Identifier: AGPL-3.0-only

// Package seal encrypts mail for its owner, so the server keeps only what it can't read. Each message gets its own
// key, which encrypts its parts with AES-256-GCM and is itself sealed with HPKE to the user's X25519 public key. Only
// the user's devices hold the private key; the engine can encrypt but never decrypt again. The clients read the same
// format in packages/sdk/src/crypto.ts and apps/apple/Nouvex/Crypto.swift.
package seal

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hpke"
	"crypto/rand"
)

// Info binds a sealed message key to its purpose, so it can't be passed off as anything else.
const Info = "nouvex message key"

// NewKey is a fresh key for one message.
func NewKey() []byte {
	k := make([]byte, 32)
	_, _ = rand.Read(k)
	return k
}

// Wrap seals a message key to the user's public key: the encapsulated key, then the sealed message key.
func Wrap(public, key []byte) ([]byte, error) {
	pub, err := ecdh.X25519().NewPublicKey(public)
	if err != nil {
		return nil, err
	}
	pk, err := hpke.NewDHKEMPublicKey(pub)
	if err != nil {
		return nil, err
	}
	return hpke.Seal(pk, hpke.HKDFSHA256(), hpke.AES256GCM(), []byte(Info), key)
}

// Encrypt is AES-256-GCM with a random nonce in front. The label ("meta", "body", "att/0") goes in as associated
// data, so one part of a message can't stand in for another.
func Encrypt(key []byte, label string, plain []byte) []byte {
	gcm := aead(key)
	nonce := make([]byte, gcm.NonceSize())
	_, _ = rand.Read(nonce)
	return gcm.Seal(nonce, nonce, plain, []byte(label))
}

func aead(key []byte) cipher.AEAD {
	block, err := aes.NewCipher(key)
	if err != nil {
		panic(err) // only ever called with keys from NewKey
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		panic(err)
	}
	return gcm
}
