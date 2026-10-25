# Trivy DB fixtures for `scripts/ci-trivy-db.test.mjs`

Genuine bbolt files, written by go.etcd.io/bbolt v1.4.3 (not by the reader under test), so
the structure tests check the reader against the real format rather than against itself.

| file        | what it is                                                                                                                                                                                                                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `real.db`   | A subset of the real Trivy DB (UpdatedAt 2026-10-25T01:20:33Z, mirror.gcr.io/aquasec/trivy-db:2): the `lodash` npm advisories, three `alpine 3.24` packages, the `vulnerability` entries they reference and their `data-source` rows. Trivy 0.70.0 scanning a lockfile with lodash 4.17.20 against it reports CVE-2021-23337 (HIGH). |
| `empty.db`  | A valid bbolt file with no buckets.                                                                                                                                                                                                                                                                                                  |
| `hollow.db` | Every required bucket present and empty. Trivy 0.70.0 opens it, finds nothing and exits 0: the reason the content check exists.                                                                                                                                                                                                      |

Regenerate with the program below (`go run . <real trivy.db> <out dir>`, module requiring
`go.etcd.io/bbolt v1.4.3`); the metadata and provenance files are written by the tests.

```go
// Builds small, genuine bbolt fixtures from a real Trivy DB (read-only).
//   real.db   : subset (lodash npm advisories, 3 alpine 3.24 packages, the
//               vulnerability details they reference, their data-source rows)
//   empty.db  : a valid bbolt file with no buckets
//   hollow.db : every required bucket present, all empty
package main

import (
	"log"
	"os"

	bolt "go.etcd.io/bbolt"
)

func copyBucket(dst, src *bolt.Bucket, refs map[string]bool) error {
	return src.ForEach(func(k, v []byte) error {
		if v == nil {
			sub, err := dst.CreateBucketIfNotExists(k)
			if err != nil {
				return err
			}
			return copyBucket(sub, src.Bucket(k), refs)
		}
		if refs != nil {
			refs[string(k)] = true
		}
		return dst.Put(k, v)
	})
}

func main() {
	src, err := bolt.Open(os.Args[1], 0o400, &bolt.Options{ReadOnly: true})
	if err != nil {
		log.Fatal(err)
	}
	defer src.Close()
	out := os.Args[2]
	_ = os.MkdirAll(out, 0o755)
	for _, n := range []string{"real.db", "empty.db", "hollow.db"} {
		_ = os.Remove(out + "/" + n)
	}
	dst, err := bolt.Open(out+"/real.db", 0o644, nil)
	if err != nil {
		log.Fatal(err)
	}
	refs := map[string]bool{}
	err = src.View(func(stx *bolt.Tx) error {
		return dst.Update(func(dtx *bolt.Tx) error {
			npm := stx.Bucket([]byte("npm::GitHub Security Advisory npm"))
			d, _ := dtx.CreateBucket([]byte("npm::GitHub Security Advisory npm"))
			l, _ := d.CreateBucket([]byte("lodash"))
			if err := copyBucket(l, npm.Bucket([]byte("lodash")), refs); err != nil {
				return err
			}
			alp := stx.Bucket([]byte("alpine 3.24"))
			da, _ := dtx.CreateBucket([]byte("alpine 3.24"))
			c := alp.Cursor()
			i := 0
			for k, v := c.First(); k != nil && i < 3; k, v = c.Next() {
				if v != nil {
					continue
				}
				sub, _ := da.CreateBucket(k)
				if err := copyBucket(sub, alp.Bucket(k), refs); err != nil {
					return err
				}
				i++
			}
			vs := stx.Bucket([]byte("vulnerability"))
			dv, _ := dtx.CreateBucket([]byte("vulnerability"))
			for id := range refs {
				if v := vs.Get([]byte(id)); v != nil {
					if err := dv.Put([]byte(id), v); err != nil {
						return err
					}
				}
			}
			ds := stx.Bucket([]byte("data-source"))
			dd, _ := dtx.CreateBucket([]byte("data-source"))
			for _, n := range []string{"npm::GitHub Security Advisory npm", "alpine 3.24"} {
				if v := ds.Get([]byte(n)); v != nil {
					if err := dd.Put([]byte(n), v); err != nil {
						return err
					}
				}
			}
			return nil
		})
	})
	if err != nil {
		log.Fatal(err)
	}
	dst.Close()
	e, err := bolt.Open(out+"/empty.db", 0o644, nil)
	if err != nil {
		log.Fatal(err)
	}
	e.Close()
	h, err := bolt.Open(out+"/hollow.db", 0o644, nil)
	if err != nil {
		log.Fatal(err)
	}
	_ = h.Update(func(tx *bolt.Tx) error {
		for _, n := range []string{"vulnerability", "data-source", "npm::GitHub Security Advisory npm", "alpine 3.24"} {
			if _, err := tx.CreateBucket([]byte(n)); err != nil {
				return err
			}
		}
		return nil
	})
	h.Close()
	log.Printf("refs=%d", len(refs))
}
```
