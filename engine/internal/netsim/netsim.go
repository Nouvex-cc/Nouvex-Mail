// SPDX-License-Identifier: AGPL-3.0-only

// Package netsim adds network latency for tests and benchmarks.
package netsim

import (
	"net"
	"testing"
	"time"
)

// Proxy listens on a local port and forwards to target with rtt added to every round trip, the TCP handshake
// included, like a server somewhere on the internet. It closes when the test ends.
// ponytail: latency only, no bandwidth limit; a first sync over a slow line is also bound by its bandwidth.
func Proxy(b testing.TB, target string, rtt time.Duration) string {
	oneWay := rtt / 2
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		b.Fatal(err)
	}
	b.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				time.Sleep(2 * oneWay)
				s, err := net.Dial("tcp", target)
				if err != nil {
					_ = c.Close()
					return
				}
				go delayed(s, c, oneWay)
				delayed(c, s, oneWay)
			}()
		}
	}()
	return ln.Addr().String()
}

// delayed copies src to dst, each read arriving d after it was read.
func delayed(dst, src net.Conn, d time.Duration) {
	type chunk struct {
		at time.Time
		b  []byte
	}
	ch := make(chan chunk, 4096)
	go func() {
		defer close(ch)
		for {
			buf := make([]byte, 64<<10)
			n, err := src.Read(buf)
			if n > 0 {
				ch <- chunk{time.Now().Add(d), buf[:n]}
			}
			if err != nil {
				return
			}
		}
	}()
	for c := range ch {
		time.Sleep(time.Until(c.at))
		if _, err := dst.Write(c.b); err != nil {
			break
		}
	}
	_ = dst.Close()
	_ = src.Close()
}
