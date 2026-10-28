// SPDX-License-Identifier: AGPL-3.0-only

package mail

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/emersion/go-message/mail"
)

// Embedder turns text into vectors through the embed service (Hugging Face Text Embeddings Inference with
// multilingual-e5-small, deploy/compose.yml), which runs next to the engine; mail never leaves the server.
type Embedder struct {
	url    string
	client *http.Client
}

func NewEmbedder(url string) *Embedder {
	return &Embedder{url: strings.TrimRight(url, "/"), client: &http.Client{Timeout: 30 * time.Second}}
}

// embedBatch is what the service takes in one request (--max-client-batch-size).
const embedBatch = 32

// Embed returns one unit-length vector per text, in order.
func (e *Embedder) Embed(ctx context.Context, texts []string) ([][]float32, error) {
	var out [][]float32
	for i := 0; i < len(texts); i += embedBatch {
		part := texts[i:min(i+embedBatch, len(texts))]
		body, _ := json.Marshal(map[string]any{"inputs": part, "truncate": true, "normalize": true})
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, e.url+"/embed", bytes.NewReader(body))
		if err != nil {
			return nil, err
		}
		req.Header.Set("content-type", "application/json")
		res, err := e.client.Do(req)
		if err != nil {
			return nil, err
		}
		var got [][]float32
		err = json.NewDecoder(res.Body).Decode(&got)
		_ = res.Body.Close()
		if res.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("embed: %s", res.Status)
		}
		if err != nil {
			return nil, err
		}
		if len(got) != len(part) {
			return nil, fmt.Errorf("embed: %d vectors for %d texts", len(got), len(part))
		}
		out = append(out, got...)
	}
	return out, nil
}

// Sample is what sorting looks at for one message: a text to embed and signals from its headers, which the text
// doesn't carry.
type Sample struct {
	Text    string
	Signals []float32
}

// sampled builds a message's Sample. The text is who it's from, the subject and how it begins, prefixed the way e5
// models expect.
func sampled(h mail.Header, subject, text string, acts []Action) Sample {
	var name, from string
	if list, _ := h.AddressList("From"); len(list) > 0 {
		name, from = list[0].Name, strings.ToLower(list[0].Address)
	}
	local, domain, _ := strings.Cut(from, "@")
	if r := []rune(text); len(r) > 1000 {
		text = string(r[:1000])
	}
	precedence := strings.ToLower(h.Get("Precedence"))
	bulk := h.Get("List-Unsubscribe") != "" || precedence == "bulk" || precedence == "list" ||
		strings.Contains(strings.ToLower(h.Get("Return-Path")), "bounce") || h.Get("Feedback-ID") != ""
	code := slices.ContainsFunc(acts, func(a Action) bool { return a.Kind == "code" })
	social := slices.ContainsFunc(socialDomains, func(d string) bool { return domain == d || strings.HasSuffix(domain, "."+d) })
	bit := func(b bool) float32 {
		if b {
			return 1
		}
		return 0
	}
	return Sample{
		Text: fmt.Sprintf("passage: From %s <%s>. Subject: %s. %s", name, domain, subject, text),
		Signals: []float32{
			bit(bulk),
			bit(h.Get("List-Id") != ""),
			bit(strings.HasPrefix(strings.ToLower(h.Get("Auto-Submitted")), "auto-generated")),
			bit(robot.MatchString(local)),
			bit(notifier.MatchString(local) || notifierHost.MatchString(domain)),
			bit(social),
			bit(sale.MatchString(subject)),
			bit(transactional.MatchString(subject)),
			bit(code),
			bit(h.Get("In-Reply-To") != ""),
			bit(signed(h)),
		},
	}
}
