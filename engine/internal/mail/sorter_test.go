// SPDX-License-Identifier: AGPL-3.0-only

package mail

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func TestHeadLearns(t *testing.T) {
	// Each label lights up its own feature, with a bit of the others.
	var examples []Example
	for i := range 300 {
		k := i % len(Labels)
		x := make([]float32, 8)
		for j := range x {
			x[j] = float32((i*7+j*3)%5) / 20
		}
		x[k] = 1
		examples = append(examples, Example{X: x, Label: k})
	}
	h := Fit(examples)
	again, err := UnmarshalHead(h.Marshal())
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range examples[:12] {
		p := again.Probs(e.X)
		for k := range p {
			if k != e.Label && p[k] >= p[e.Label] {
				t.Fatalf("label %d: %v", e.Label, p)
			}
		}
	}
}

func TestEmbedder(t *testing.T) {
	var calls int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		var req struct{ Inputs []string }
		_ = json.NewDecoder(r.Body).Decode(&req)
		out := make([][]float32, len(req.Inputs))
		for i, in := range req.Inputs {
			out[i] = []float32{float32(len(in))}
		}
		_ = json.NewEncoder(w).Encode(out)
	}))
	defer srv.Close()
	texts := make([]string, 70)
	for i := range texts {
		texts[i] = strings.Repeat("a", i)
	}
	got, err := NewEmbedder(srv.URL).Embed(context.Background(), texts)
	if err != nil {
		t.Fatal(err)
	}
	if calls != 3 || len(got) != 70 || got[69][0] != 69 {
		t.Fatalf("%d calls, %d vectors", calls, len(got))
	}

	srv.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Error(w, "busy", http.StatusTooManyRequests) })
	if _, err := NewEmbedder(srv.URL).Embed(context.Background(), texts); err == nil {
		t.Fatal("a busy service should fail, so the rules sort")
	}
}

func TestDecide(t *testing.T) {
	for _, c := range []struct {
		name  string
		probs []float64
		rules string
		want  string
	}{
		{"sure", []float64{0.05, 0.05, 0.05, 0.8, 0.03, 0.02}, "newsletters", "updates"},
		{"unsure keeps the rules", []float64{0.3, 0.1, 0.1, 0.4, 0.05, 0.05}, "newsletters", "newsletters"},
		{"sure spam keeps the rules", []float64{0.02, 0.1, 0.02, 0.02, 0.02, 0.82}, "promotions", "promotions"},
	} {
		if got := decide(c.probs, c.rules); got != c.want {
			t.Errorf("%s: %s, want %s", c.name, got, c.want)
		}
	}
}

// TestSortingModel runs against a real embed service (EMBED_URL, e.g. the compose one) and compares the model with
// the rules: each mail of sorting.txt is sorted by a model trained on all the others.
func TestSortingModel(t *testing.T) {
	url := os.Getenv("EMBED_URL")
	if url == "" {
		t.Skip("EMBED_URL not set")
	}
	s := NewSorter(url)
	seed, err := s.Seed(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	labels, samples, _ := seedSamples()
	var model, rules int
	for i, e := range seed {
		rest := append(append([]Example{}, seed[:i]...), seed[i+1:]...)
		p := Fit(rest).Probs(e.X)
		_, raw, _ := strings.Cut(strings.Split(seedMail, "\n=== ")[i+1], "\n")
		parsed, _ := Content([]byte(raw))
		got := decide(p, parsed.Category)
		if got == Labels[labels[i]] {
			model++
		} else {
			t.Logf("model: %s as %s: %.60s", Labels[labels[i]], got, samples[i].Text)
		}
		if parsed.Category == Labels[labels[i]] {
			rules++
		}
	}
	t.Logf("right: model %d, rules %d, of %d", model, rules, len(seed))
	if model < rules {
		t.Errorf("the model sorts worse than the rules: %d < %d", model, rules)
	}
}
