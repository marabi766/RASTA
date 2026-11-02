package main

// The checker's controls, run in the producer's build step before any DB is
// downloaded (PR #435 round 4, addendum C): the genuine fixture must pass,
// and the review's ordered-separator mutation and every one of the fixture's
// 17 branch separators raised by one must fail. A checker that refuses
// everything, or nothing, stops the producer here.

import (
	"bytes"
	"encoding/binary"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The genuine bbolt v1.4.3 fixture the JS tests use too.
const fixture = "../fixtures/trivy-db/real.db"

func read(t *testing.T) []byte {
	t.Helper()
	b, err := os.ReadFile(fixture)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

type separator struct {
	key  string
	at   int    // offset of the key in the file
	next []byte // the next separator on the page (nil for the last)
}

// separators lists every key on every branch page of a bbolt file.
func separators(t *testing.T, b []byte) []separator {
	t.Helper()
	le := binary.LittleEndian
	pageSize := int(le.Uint32(b[24:]))
	var out []separator
	for off := 0; off+16 <= len(b); off += pageSize {
		flags, count := le.Uint16(b[off+8:]), int(le.Uint16(b[off+10:]))
		if flags == 0x01 {
			start := len(out)
			for i := 0; i < count; i++ {
				e := off + 16 + i*16
				at := e + int(le.Uint32(b[e:]))
				key := b[at : at+int(le.Uint32(b[e+4:]))]
				out = append(out, separator{key: string(key), at: at})
				if i > 0 {
					out[start+i-1].next = key
				}
			}
		}
		off += int(le.Uint32(b[off+12:])) * pageSize
	}
	return out
}

// raised writes a copy whose separator s has its last byte raised by one,
// still ordered against the next separator (the review's condition).
func raised(t *testing.T, b []byte, s separator) string {
	t.Helper()
	c := bytes.Clone(b)
	last := s.at + len(s.key) - 1
	c[last]++
	if s.next != nil && bytes.Compare(c[s.at:last+1], s.next) >= 0 {
		t.Fatalf("raising %q breaks the page's order", s.key)
	}
	p := filepath.Join(t.TempDir(), "mutated.db")
	if err := os.WriteFile(p, c, 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func mustFail(t *testing.T, path, key string) {
	t.Helper()
	var out bytes.Buffer
	if code := run([]string{"trivy-db-check", path}, &out); code != 1 {
		t.Fatalf("exit %d, want 1 (corruption); output %q", code, out.String())
	}
	lines := strings.Split(strings.TrimSuffix(out.String(), "\n"), "\n")
	if len(lines) > maxLines+1 || !strings.HasSuffix(lines[len(lines)-1], " problems") {
		t.Fatalf("report not bounded: %q", out.String())
	}
	hex := []byte(nil)
	for _, c := range []byte(key) {
		hex = append(hex, "0123456789abcdef"[c>>4], "0123456789abcdef"[c&15])
	}
	if strings.Contains(out.String(), key) || strings.Contains(out.String(), string(hex)) {
		t.Fatalf("report repeats a key: %q", out.String())
	}
}

func TestGenuineFixturePasses(t *testing.T) {
	var out bytes.Buffer
	if code := run([]string{"trivy-db-check", fixture}, &out); code != 0 || out.String() != "ok\n" {
		t.Fatalf("exit %d, output %q; want 0, \"ok\\n\"", code, out.String())
	}
}

func TestReviewSeparatorMutationFails(t *testing.T) {
	b := read(t)
	for _, s := range separators(t, b) {
		if s.key == "CVE-2020-8203" { // -> CVE-2020-8204
			mustFail(t, raised(t, b, s), s.key)
			return
		}
	}
	t.Fatal("the fixture has no separator CVE-2020-8203")
}

func TestEverySeparatorRaisedFails(t *testing.T) {
	b := read(t)
	seps := separators(t, b)
	if len(seps) != 17 {
		t.Fatalf("%d separators, want the fixture's 17", len(seps))
	}
	for _, s := range seps {
		t.Run(s.key, func(t *testing.T) { mustFail(t, raised(t, b, s), s.key) })
	}
}

func TestUnopenableFileFails(t *testing.T) {
	p := filepath.Join(t.TempDir(), "garbage.db")
	if err := os.WriteFile(p, bytes.Repeat([]byte{0xff}, 1<<16), 0o600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if code := run([]string{"trivy-db-check", p}, &out); code != 2 || strings.Contains(out.String(), p) {
		t.Fatalf("exit %d, output %q", code, out.String())
	}
}

func TestDiagnosticsAreBoundedAndRedacted(t *testing.T) {
	b := read(t)
	seps := separators(t, b)
	for _, s := range seps {
		b[s.at+len(s.key)-1]++
	}
	p := filepath.Join(t.TempDir(), "many-errors.db")
	if err := os.WriteFile(p, b, 0o600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if code := run([]string{"trivy-db-check", p}, &out); code != 1 {
		t.Fatalf("exit %d, want corruption", code)
	}
	lines := strings.Split(strings.TrimSuffix(out.String(), "\n"), "\n")
	if len(lines) != maxLines+1 || out.Len() > maxLines*(maxLineBytes+1)+32 {
		t.Fatalf("unbounded report: %d lines, %d bytes", len(lines), out.Len())
	}
	for _, s := range seps {
		if strings.Contains(out.String(), s.key) {
			t.Fatal("report contains a database key")
		}
	}
}
