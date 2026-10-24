// SPDX-License-Identifier: AGPL-3.0-only

package mail

import (
	"bufio"
	"bytes"
	"os"
	"path/filepath"
)

// Corpus returns the messages in a folder, one per file, or in an mbox file: training data for the spam model.
func Corpus(path string) ([][]byte, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return mbox(path)
	}
	var msgs [][]byte
	err = filepath.WalkDir(path, func(p string, e os.DirEntry, err error) error {
		if err != nil || e.IsDir() || e.Name() == "cmds" {
			return err
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		// The corpus keeps the mbox "From " line on top, which isn't a header.
		if bytes.HasPrefix(b, []byte("From ")) {
			_, b, _ = bytes.Cut(b, []byte("\n"))
		}
		msgs = append(msgs, b)
		return nil
	})
	return msgs, err
}

func mbox(path string) ([][]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	var msgs [][]byte
	var cur bytes.Buffer
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 64<<20)
	for sc.Scan() {
		line := sc.Bytes()
		if bytes.HasPrefix(line, []byte("From ")) {
			if cur.Len() > 0 {
				msgs = append(msgs, bytes.Clone(cur.Bytes()))
			}
			cur.Reset()
			continue
		}
		cur.Write(line)
		cur.WriteString("\r\n")
	}
	if cur.Len() > 0 {
		msgs = append(msgs, cur.Bytes())
	}
	return msgs, sc.Err()
}
