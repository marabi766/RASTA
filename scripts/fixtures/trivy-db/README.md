# Trivy DB fixtures for `scripts/ci-trivy-db.test.mjs`

Genuine bbolt files, written by go.etcd.io/bbolt v1.4.3 (not by the reader under test), so
the structure tests check the reader against the real format rather than against itself.

| file        | what it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `real.db`   | A subset of the real Trivy DB (UpdatedAt 2026-10-25T01:20:33Z, mirror.gcr.io/aquasec/trivy-db:2): the `lodash` npm advisories, the first three `alpine 3.24` packages and `zlib`, the `tokio` Rust advisories, the `vulnerability` entries they reference (a branch page with 17 leaves) and their `data-source` rows. Trivy 0.70.0 scanning the canary root (apk zlib 1.2.12-r0, node_modules lodash 4.17.20, Cargo.lock tokio 1.8.0 on Alpine 3.24) against it reports CVE-2022-37434 (CRITICAL), CVE-2021-23337 (HIGH) and CVE-2021-45710 (HIGH). |
| `sparse.db` | `real.db` plus one empty package bucket in `alpine 3.24`: structurally valid, refused for its content.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `empty.db`  | A valid bbolt file with no buckets.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `hollow.db` | Every required bucket present and empty. Trivy 0.70.0 opens it, finds nothing and exits 0: the reason the content check exists.                                                                                                                                                                                                                                                                                                                                                                                                                      |

Regenerate with the program below (`go run . <real trivy.db> <out dir>`, module requiring
`go.etcd.io/bbolt v1.4.3`); the metadata and provenance files are written by the tests.
The output is deterministic: rerunning it on the same DB writes the same bytes.

```go
// Builds small, genuine bbolt fixtures from a real Trivy DB (read-only).
//
//	real.db   : subset (lodash npm advisories, the first 3 alpine 3.24
//	            packages and zlib, tokio's Rust advisories, the vulnerability
//	            details they reference, their data-source rows)
//	sparse.db : real.db plus one empty package bucket in alpine 3.24
//	empty.db  : a valid bbolt file with no buckets
//	hollow.db : every required bucket present, all empty
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
	for _, n := range []string{"real.db", "sparse.db", "empty.db", "hollow.db"} {
		_ = os.Remove(out + "/" + n)
	}
	subset(src, out+"/real.db", false)
	subset(src, out+"/sparse.db", true)

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
		for _, n := range []string{"vulnerability", "data-source", "npm::GitHub Security Advisory npm", "alpine 3.24", "cargo::GitHub Security Advisory Rust"} {
			if _, err := tx.CreateBucket([]byte(n)); err != nil {
				return err
			}
		}
		return nil
	})
	h.Close()
}

// subset writes the real.db subset to path; emptyPkg adds an empty package
// bucket to alpine 3.24 (sparse.db).
func subset(src *bolt.DB, path string, emptyPkg bool) {
	dst, err := bolt.Open(path, 0o644, nil)
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
			if emptyPkg {
				if _, err := da.CreateBucket([]byte("zz-empty")); err != nil {
					return err
				}
			}
			z, _ := da.CreateBucket([]byte("zlib"))
			if err := copyBucket(z, alp.Bucket([]byte("zlib")), refs); err != nil {
				return err
			}
			rs := stx.Bucket([]byte("cargo::GitHub Security Advisory Rust"))
			dr, _ := dtx.CreateBucket([]byte("cargo::GitHub Security Advisory Rust"))
			t, _ := dr.CreateBucket([]byte("tokio"))
			if err := copyBucket(t, rs.Bucket([]byte("tokio")), refs); err != nil {
				return err
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
			for _, n := range []string{"npm::GitHub Security Advisory npm", "alpine 3.24", "cargo::GitHub Security Advisory Rust"} {
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
	log.Printf("%s: refs=%d", path, len(refs))
}
```
