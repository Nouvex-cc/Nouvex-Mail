// SPDX-License-Identifier: AGPL-3.0-only

// Train builds internal/mail/spam.model from mail sorted into ham and spam. Each path is a folder with one message per
// file (the SpamAssassin public corpus) or an mbox file (Jose Nazario's phishing corpus, CC BY 4.0):
//
//	go run ./cmd/train -ham easy_ham,hard_ham -spam spam,spam_2,phishing-2024 -o internal/mail/spam.model
//
// A fifth of the mail is held back to pick the threshold: the lowest one that keeps wrongly flagged ham under -fpr.
// Then the model is trained on everything.
package main

import (
	"bytes"
	"encoding/binary"
	"flag"
	"fmt"
	"log"
	"math"
	"os"
	"sort"
	"strings"

	"github.com/Nouvex-cc/Nouvex-Mail/engine/internal/mail"
)

type doc struct {
	slots []uint32
	spam  bool
}

func main() {
	ham := flag.String("ham", "", "comma-separated folders or mbox files of wanted mail")
	spam := flag.String("spam", "", "comma-separated folders or mbox files of spam")
	out := flag.String("o", "internal/mail/spam.model", "where to write the model")
	fpr := flag.Float64("fpr", 0.001, "share of held-back ham that may be flagged")
	flag.Parse()

	var docs []doc
	skipped := 0
	for _, set := range []struct {
		paths string
		spam  bool
	}{{*ham, false}, {*spam, true}} {
		for _, p := range strings.Split(set.paths, ",") {
			if p == "" {
				continue
			}
			msgs, err := mail.Corpus(p)
			if err != nil {
				log.Fatal(err)
			}
			for _, raw := range msgs {
				parsed, err := mail.Content(raw)
				if err != nil || len(parsed.Tokens) == 0 {
					skipped++
					continue
				}
				d := doc{spam: set.spam}
				for _, t := range parsed.Tokens {
					d.slots = append(d.slots, mail.Slot(t))
				}
				docs = append(docs, d)
			}
			log.Printf("%s: %d messages", p, len(msgs))
		}
	}
	log.Printf("%d messages couldn't be read", skipped)

	var train, test []doc
	for i, d := range docs {
		if i%5 == 0 {
			test = append(test, d)
		} else {
			train = append(train, d)
		}
	}
	weights := fit(train)
	var hamScores []float64
	var spamScores []float64
	for _, d := range test {
		if d.spam {
			spamScores = append(spamScores, score(weights, d))
		} else {
			hamScores = append(hamScores, score(weights, d))
		}
	}
	sort.Float64s(hamScores)
	// The threshold sits just above the ham the target lets through, and never below even odds.
	allowed := int(*fpr * float64(len(hamScores)))
	threshold := math.Max(0, hamScores[len(hamScores)-1-allowed]+0.01)
	caught := 0
	for _, s := range spamScores {
		if s >= threshold {
			caught++
		}
	}
	flagged := 0
	for _, s := range hamScores {
		if s >= threshold {
			flagged++
		}
	}
	log.Printf("held back: %d ham, %d spam; log-odds threshold %.2f flags %d ham (%.2f%%) and catches %.1f%% of spam",
		len(hamScores), len(spamScores), threshold, flagged, 100*float64(flagged)/float64(len(hamScores)),
		100*float64(caught)/float64(len(spamScores)))

	weights = fit(docs)
	var buf bytes.Buffer
	_ = binary.Write(&buf, binary.LittleEndian, float32(threshold))
	for _, w := range weights {
		buf.WriteByte(byte(int8(math.Round(math.Max(-127, math.Min(127, w*16))))))
	}
	if err := os.WriteFile(*out, buf.Bytes(), 0o644); err != nil {
		log.Fatal(err)
	}
	fmt.Println("wrote", *out)
}

// fit counts in how many ham and spam messages each slot shows up and turns that into log-odds, smoothed so a slot
// seen once doesn't decide anything. Ham and spam weigh the same however many of each there are.
func fit(docs []doc) []float64 {
	hamCount := make([]float64, mail.Slots)
	spamCount := make([]float64, mail.Slots)
	var nHam, nSpam float64
	for _, d := range docs {
		count := hamCount
		if d.spam {
			count, nSpam = spamCount, nSpam+1
		} else {
			nHam++
		}
		for _, s := range d.slots {
			count[s]++
		}
	}
	w := make([]float64, mail.Slots)
	for i := range w {
		w[i] = math.Log((spamCount[i]+1)/(nSpam+2)) - math.Log((hamCount[i]+1)/(nHam+2))
	}
	return w
}

func score(w []float64, d doc) float64 {
	var logit float64
	for _, s := range d.slots {
		// The same clipping and rounding the stored model gets.
		logit += math.Round(math.Max(-127, math.Min(127, w[s]*16))) / 16
	}
	return logit
}
