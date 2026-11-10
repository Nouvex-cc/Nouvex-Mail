// SPDX-License-Identifier: AGPL-3.0-only

package mx

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"time"
)

// Rspamd checks messages with rspamd over HTTP (/checkv2, docs.rspamd.com/developers/protocol): SPF, DKIM, DMARC, ARC
// and spam in one call. The headers it adds come back in milter.add_headers (docker/rspamd/local.d), signed as host.
func Rspamd(url, host string) func(context.Context, []byte, Envelope) (Verdict, error) {
	client := &http.Client{Timeout: 30 * time.Second}
	return func(ctx context.Context, raw []byte, env Envelope) (Verdict, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimSuffix(url, "/")+"/checkv2", bytes.NewReader(raw))
		if err != nil {
			return Verdict{}, err
		}
		req.Header.Set("MTA-Name", host)
		req.Header.Set("IP", env.IP)
		req.Header.Set("Helo", env.Helo)
		req.Header.Set("From", env.From)
		for _, to := range env.To {
			req.Header.Add("Rcpt", to)
		}
		res, err := client.Do(req)
		if err != nil {
			return Verdict{}, err
		}
		defer func() { _ = res.Body.Close() }()
		if res.StatusCode != http.StatusOK {
			return Verdict{}, fmt.Errorf("rspamd: %s", res.Status)
		}
		var out struct {
			Action string `json:"action"`
			Milter struct {
				AddHeaders    map[string]json.RawMessage `json:"add_headers"`
				RemoveHeaders map[string]int             `json:"remove_headers"`
			} `json:"milter"`
		}
		if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
			return Verdict{}, err
		}
		v := Verdict{Action: out.Action}
		for name := range out.Milter.RemoveHeaders {
			v.Remove = append(v.Remove, name)
		}
		names := make([]string, 0, len(out.Milter.AddHeaders))
		for name := range out.Milter.AddHeaders {
			names = append(names, name)
		}
		slices.Sort(names)
		for _, name := range names {
			for _, value := range headerValues(out.Milter.AddHeaders[name]) {
				v.Headers = append(v.Headers, name+": "+fold(value)+"\r\n")
			}
		}
		return v, nil
	}
}

// headerValues reads a header rspamd adds: a string, {"value": …}, or a list of either.
func headerValues(raw json.RawMessage) []string {
	var one string
	if json.Unmarshal(raw, &one) == nil {
		return []string{one}
	}
	var obj struct{ Value string }
	if json.Unmarshal(raw, &obj) == nil && obj.Value != "" {
		return []string{obj.Value}
	}
	var list []json.RawMessage
	if json.Unmarshal(raw, &list) != nil {
		return nil
	}
	var out []string
	for _, item := range list {
		out = append(out, headerValues(item)...)
	}
	return out
}

// fold keeps a value's own line breaks as header continuations.
func fold(value string) string {
	value = strings.ReplaceAll(value, "\r\n", "\n")
	return strings.ReplaceAll(value, "\n", "\r\n")
}
