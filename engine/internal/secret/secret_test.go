// SPDX-License-Identifier: AGPL-3.0-only

package secret

import (
	"bytes"
	"encoding/base64"
	"testing"
)

// Sealed by apps/api/src/secret.ts with a master key of 32 bytes of 7.
const sealed = "AeVCfofwDm5ahJCtI82tdCIIVvFGf4BwyDIroAsv8BzQ4CPCXPqq675SlWplhAG7PyMZWGLwU3IYPM2t518oWtrlmqUm0PUvih+KsT87w8xD94X40wD1NabVp54hDhIi"

func TestOpen(t *testing.T) {
	master := bytes.Repeat([]byte{7}, 32)
	raw, _ := base64.StdEncoding.DecodeString(sealed)
	got, err := Open(master, raw)
	if err != nil || got != "hunter2" {
		t.Fatalf("got %q, %v", got, err)
	}
	if _, err := Open(bytes.Repeat([]byte{8}, 32), raw); err == nil {
		t.Fatal("opened with the wrong key")
	}
}
