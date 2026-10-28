// SPDX-License-Identifier: AGPL-3.0-only

package mail

import (
	"context"
	_ "embed"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/db"
	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/secret"
)

// Sorting sorts new mail with each user's model while syncing; main sets it when there's an embed service.
var Sorting *Sorter

// Sorter keeps the model everyone starts with, trained from sorting.txt on first use, and each user's own.
type Sorter struct {
	embed *Embedder
	mu    sync.Mutex
	seed  []Example
	base  *Head
	heads map[string]userHead
}

type userHead struct {
	head *Head
	at   time.Time
}

// NewSorter embeds with the service at url, e.g. http://embed:80.
func NewSorter(url string) *Sorter {
	return &Sorter{embed: NewEmbedder(url), heads: map[string]userHead{}}
}

//go:embed sorting.txt
var seedMail string

// seedSamples reads sorting.txt: label and Sample of each mail in it.
func seedSamples() ([]int, []Sample, error) {
	var labels []int
	var samples []Sample
	for _, block := range strings.Split(seedMail, "\n=== ")[1:] {
		name, raw, _ := strings.Cut(block, "\n")
		label := slices.Index(Labels, strings.TrimSpace(name))
		if label < 0 {
			return nil, nil, fmt.Errorf("sorting.txt: no label %q", name)
		}
		p, err := Content([]byte(raw))
		if err != nil {
			return nil, nil, err
		}
		labels = append(labels, label)
		samples = append(samples, p.Sample)
	}
	return labels, samples, nil
}

// Seed is sorting.txt as examples to learn from, embedded once.
func (s *Sorter) Seed(ctx context.Context) ([]Example, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.seed != nil {
		return s.seed, nil
	}
	labels, samples, err := seedSamples()
	if err != nil {
		return nil, err
	}
	vectors, err := s.vectors(ctx, samples)
	if err != nil {
		return nil, err
	}
	for i, x := range vectors {
		s.seed = append(s.seed, Example{X: x, Label: labels[i]})
	}
	s.base = Fit(s.seed)
	return s.seed, nil
}

func (s *Sorter) vectors(ctx context.Context, samples []Sample) ([][]float32, error) {
	texts := make([]string, len(samples))
	for i, m := range samples {
		texts[i] = m.Text
	}
	embeddings, err := s.embed.Embed(ctx, texts)
	if err != nil {
		return nil, err
	}
	out := make([][]float32, len(samples))
	for i, e := range embeddings {
		out[i] = Vector(e, samples[i])
	}
	return out, nil
}

// head is the user's own model, or the one everyone starts with until theirs is trained.
func (s *Sorter) head(ctx context.Context, q *db.Queries, master []byte, userID string) (*Head, error) {
	if _, err := s.Seed(ctx); err != nil {
		return nil, err
	}
	m, err := q.GetSortModel(ctx, userID)
	s.mu.Lock()
	defer s.mu.Unlock()
	if errors.Is(err, pgx.ErrNoRows) {
		return s.base, nil
	}
	if err != nil {
		return nil, err
	}
	if h, ok := s.heads[userID]; ok && h.at.Equal(m.TrainedAt.Time) {
		return h.head, nil
	}
	raw, err := secret.Open(master, m.Weights)
	if err != nil {
		return nil, err
	}
	h, err := UnmarshalHead([]byte(raw))
	if err != nil {
		return nil, err
	}
	s.heads[userID] = userHead{h, m.TrainedAt.Time}
	return h, nil
}

// Classify gives, for each sample, the share the user's model gives each of Labels.
func (s *Sorter) Classify(ctx context.Context, q *db.Queries, master []byte, userID string, samples []Sample) ([][]float64, error) {
	h, err := s.head(ctx, q, master, userID)
	if err != nil {
		return nil, err
	}
	vectors, err := s.vectors(ctx, samples)
	if err != nil {
		return nil, err
	}
	out := make([][]float64, len(vectors))
	for i, x := range vectors {
		out[i] = h.Probs(x)
	}
	return out, nil
}

// decide turns the model's shares into a tab, next to what the rules said. The model only moves a message when it's
// sure, and never calls it spam: it learns junk mail only so that it stays out of the tabs.
func decide(probs []float64, category string) string {
	top := 0
	for k, p := range probs {
		if p > probs[top] {
			top = k
		}
	}
	const sure = 0.55
	if top != spamLabel && probs[top] >= sure {
		category = Labels[top]
	}
	return category
}
