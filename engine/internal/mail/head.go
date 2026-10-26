// SPDX-License-Identifier: AGPL-3.0-only

package mail

import (
	"bytes"
	"encoding/binary"
	"errors"
	"math"
	"math/rand/v2"
)

// Labels are what sorting tells apart: the five inbox tabs, and spam.
var Labels = []string{"primary", "promotions", "social", "updates", "newsletters", "spam"}

const spamLabel = 5

// Head is a linear classifier over a message's embedding and its header signals: one weight row per label. Small
// enough to keep one per user.
type Head struct {
	Dim int
	W   []float32 // len(Labels) rows of Dim
	B   []float32
}

// Example is one message to learn from: its features and which label it has.
type Example struct {
	X     []float32
	Label int
}

// Vector is what the head reads: the embedding, then the signals.
func Vector(embedding []float32, s Sample) []float32 {
	return append(append([]float32{}, embedding...), s.Signals...)
}

// Probs is the share the head gives each label.
func (h *Head) Probs(x []float32) []float64 {
	p := make([]float64, len(Labels))
	top := math.Inf(-1)
	for k := range Labels {
		z := float64(h.B[k])
		row := h.W[k*h.Dim : (k+1)*h.Dim]
		for i, v := range x[:min(len(x), h.Dim)] {
			z += float64(row[i] * v)
		}
		p[k] = z
		top = math.Max(top, z)
	}
	sum := 0.0
	for k := range p {
		p[k] = math.Exp(p[k] - top)
		sum += p[k]
	}
	for k := range p {
		p[k] /= sum
	}
	return p
}

// Fit trains a head by stochastic gradient descent on the cross-entropy, with a little L2 so rare words of one
// mail don't decide. ponytail: plain SGD, a fixed number of passes; enough for a few thousand examples.
func Fit(examples []Example) *Head {
	if len(examples) == 0 {
		return nil
	}
	dim := len(examples[0].X)
	h := &Head{Dim: dim, W: make([]float32, len(Labels)*dim), B: make([]float32, len(Labels))}
	r := rand.New(rand.NewPCG(1, 1))
	order := make([]int, len(examples))
	for i := range order {
		order[i] = i
	}
	const passes, l2 = 40, 1e-4
	for pass := range passes {
		rate := 0.5 / (1 + float64(pass)/10)
		r.Shuffle(len(order), func(i, j int) { order[i], order[j] = order[j], order[i] })
		for _, i := range order {
			e := examples[i]
			p := h.Probs(e.X)
			for k := range Labels {
				g := p[k]
				if k == e.Label {
					g--
				}
				g *= rate
				row := h.W[k*dim : (k+1)*dim]
				for j, v := range e.X {
					row[j] -= float32(g*float64(v) + rate*l2*float64(row[j]))
				}
				h.B[k] -= float32(g)
			}
		}
	}
	return h
}

// Marshal is the head as bytes, to keep sealed.
func (h *Head) Marshal() []byte {
	var b bytes.Buffer
	_ = binary.Write(&b, binary.LittleEndian, uint32(h.Dim))
	_ = binary.Write(&b, binary.LittleEndian, h.W)
	_ = binary.Write(&b, binary.LittleEndian, h.B)
	return b.Bytes()
}

// UnmarshalHead reads what Marshal wrote.
func UnmarshalHead(raw []byte) (*Head, error) {
	r := bytes.NewReader(raw)
	var dim uint32
	if err := binary.Read(r, binary.LittleEndian, &dim); err != nil {
		return nil, err
	}
	h := &Head{Dim: int(dim), W: make([]float32, len(Labels)*int(dim)), B: make([]float32, len(Labels))}
	if err := errors.Join(binary.Read(r, binary.LittleEndian, h.W), binary.Read(r, binary.LittleEndian, h.B)); err != nil {
		return nil, err
	}
	return h, nil
}
