// Command trivy-db-check runs go.etcd.io/bbolt's own consistency check
// (Tx.Check, what `bbolt check` runs) on one bbolt file, read-only. The
// producer of the shared Trivy DB (scripts/ci-trivy-db-lib.mjs, validateCopy)
// runs it on every downloaded copy before sealing it (PR #435 round 4,
// D-076): bbolt's check covers what the JS reader does not, above all that
// every branch separator bounds its child's keys, so a search reaches every
// record the walk counted.
//
// Output, read by validateCopy: exactly "ok\n" and exit 0 when bbolt
// reports nothing. Otherwise at most maxLines problem lines of at most
// maxLineBytes each and a count, then exit 1 (corruption), or one fixed
// line and exit 2 (wrong usage, the file does not open). A panic exits 2
// with Go's trace on stderr, which the caller discards. Keys and values
// never reach the output: bbolt quotes them through redacted.
package main

import (
	"fmt"
	"io"
	"os"
	"time"

	bolt "go.etcd.io/bbolt"
)

const (
	maxLines     = 10
	maxLineBytes = 300
)

// redacted replaces every key and value bbolt would quote in a problem.
type redacted struct{}

func (redacted) KeyToString([]byte) string   { return "<key>" }
func (redacted) ValueToString([]byte) string { return "<value>" }

// check returns the first maxLines problems bbolt reports and their count.
func check(path string) ([]string, int, error) {
	db, err := bolt.Open(path, 0o400, &bolt.Options{ReadOnly: true, Timeout: time.Second})
	if err != nil {
		return nil, 0, err
	}
	defer db.Close()
	var problems []string
	count := 0
	err = db.View(func(tx *bolt.Tx) error {
		for e := range tx.Check(bolt.WithKVStringer(redacted{})) {
			count++
			if len(problems) < maxLines {
				line := e.Error()
				if len(line) > maxLineBytes {
					line = line[:maxLineBytes]
				}
				problems = append(problems, line)
			}
		}
		return nil
	})
	return problems, count, err
}

func run(args []string, stdout io.Writer) int {
	if len(args) != 2 {
		fmt.Fprintln(stdout, "usage: trivy-db-check <trivy.db>")
		return 2
	}
	problems, count, err := check(args[1])
	if err != nil {
		fmt.Fprintln(stdout, "the file does not open as a bbolt database")
		return 2
	}
	if count == 0 {
		fmt.Fprintln(stdout, "ok")
		return 0
	}
	for _, p := range problems {
		fmt.Fprintln(stdout, p)
	}
	fmt.Fprintf(stdout, "%d problems\n", count)
	return 1
}

func main() {
	os.Exit(run(os.Args, os.Stdout))
}
