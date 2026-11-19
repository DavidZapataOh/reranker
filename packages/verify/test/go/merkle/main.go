// Command go writes the Merkle proof fixtures that pin the inclusion and consistency checks of
// @reranker/verify to two reference implementations: golang.org/x/mod/sumdb/tlog proves records
// in trees of 1 to 1100 entries, transparency-dev/merkle's testonly tree proves every leaf and
// size of the RFC 6962 vectors, and transparency-dev/merkle/proof checks every proof before it is
// written. With --check it regenerates the file in memory and fails when the committed one differs.
package main

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"os"

	"github.com/transparency-dev/merkle/proof"
	"github.com/transparency-dev/merkle/rfc6962"
	"github.com/transparency-dev/merkle/testonly"
	"golang.org/x/mod/sumdb/tlog"
)

const records = 1100

type store []tlog.Hash

func (s store) ReadHashes(indexes []int64) ([]tlog.Hash, error) {
	out := make([]tlog.Hash, len(indexes))
	for i, index := range indexes {
		out[i] = s[index]
	}
	return out, nil
}

type inclusion struct {
	Index uint64   `json:"index"`
	Size  uint64   `json:"size"`
	Leaf  string   `json:"leaf"`
	Proof []string `json:"proof"`
	Root  string   `json:"root"`
}

type consistency struct {
	Size1 uint64   `json:"size1"`
	Size2 uint64   `json:"size2"`
	Root1 string   `json:"root1"`
	Root2 string   `json:"root2"`
	Proof []string `json:"proof"`
}

// Tree sizes around the powers of two where proofs change shape, up to the largest tree.
var sizes = []int64{1, 2, 3, 4, 5, 6, 7, 8, 9, 15, 16, 17, 31, 32, 33, 255, 256, 257, 511, 512, 513, 1023, 1024, 1025, 1099, 1100}

func recordData(n int64) []byte { return []byte(fmt.Sprintf("reranker tlog record %d", n)) }

func hexHashes(hashes []tlog.Hash) []string {
	out := make([]string, len(hashes))
	for i, h := range hashes {
		out[i] = hex.EncodeToString(h[:])
	}
	return out
}

func hexBytes(hashes [][]byte) []string {
	out := make([]string, len(hashes))
	for i, h := range hashes {
		out[i] = hex.EncodeToString(h)
	}
	return out
}

func decode(v string) []byte {
	b, err := hex.DecodeString(v)
	if err != nil {
		panic(err)
	}
	return b
}

func decodeAll(values []string) [][]byte {
	out := make([][]byte, len(values))
	for i, v := range values {
		out[i] = decode(v)
	}
	return out
}

func fromTlog() ([]inclusion, []consistency, error) {
	var s store
	for n := int64(0); n < records; n++ {
		hashes, err := tlog.StoredHashes(n, recordData(n), s)
		if err != nil {
			return nil, nil, err
		}
		s = append(s, hashes...)
	}
	root := func(t int64) string {
		h, err := tlog.TreeHash(t, s)
		if err != nil {
			panic(err)
		}
		return hex.EncodeToString(h[:])
	}

	inclusions := []inclusion{}
	consistencies := []consistency{}
	for _, t := range sizes {
		for _, n := range sample(t) {
			p, err := tlog.ProveRecord(t, n, s)
			if err != nil {
				return nil, nil, err
			}
			leaf := tlog.RecordHash(recordData(n))
			inclusions = append(inclusions, inclusion{
				Index: uint64(n), Size: uint64(t), Leaf: hex.EncodeToString(leaf[:]), Proof: hexHashes(p), Root: root(t),
			})
		}
		for _, n := range sizes {
			if n > t {
				break
			}
			p, err := tlog.ProveTree(t, n, s)
			if err != nil {
				return nil, nil, err
			}
			consistencies = append(consistencies, consistency{
				Size1: uint64(n), Size2: uint64(t), Root1: root(n), Root2: root(t), Proof: hexHashes(p),
			})
		}
	}
	return inclusions, consistencies, nil
}

// sample picks record indexes at both ends of the tree, at its middle and across power-of-two edges.
func sample(t int64) []int64 {
	seen := map[int64]bool{}
	out := []int64{}
	for _, n := range []int64{0, 1, t / 2, t - 2, t - 1, 255, 256, 511, 512, 1024} {
		if n >= 0 && n < t && !seen[n] {
			seen[n] = true
			out = append(out, n)
		}
	}
	return out
}

// fromTestonly proves every leaf and every pair of sizes of the eight-leaf RFC 6962 test tree.
func fromTestonly() ([]inclusion, []consistency, error) {
	tree := testonly.New(rfc6962.DefaultHasher)
	tree.AppendData(testonly.LeafInputs()...)
	inclusions := []inclusion{}
	consistencies := []consistency{}
	for size := uint64(1); size <= tree.Size(); size++ {
		for index := uint64(0); index < size; index++ {
			p, err := tree.InclusionProof(index, size)
			if err != nil {
				return nil, nil, err
			}
			inclusions = append(inclusions, inclusion{
				Index: index, Size: size, Leaf: hex.EncodeToString(tree.LeafHash(index)), Proof: hexBytes(p),
				Root: hex.EncodeToString(tree.HashAt(size)),
			})
		}
		for size1 := uint64(1); size1 <= size; size1++ {
			p, err := tree.ConsistencyProof(size1, size)
			if err != nil {
				return nil, nil, err
			}
			consistencies = append(consistencies, consistency{
				Size1: size1, Size2: size, Root1: hex.EncodeToString(tree.HashAt(size1)),
				Root2: hex.EncodeToString(tree.HashAt(size)), Proof: hexBytes(p),
			})
		}
	}
	return inclusions, consistencies, nil
}

func fixtures() ([]byte, error) {
	inclusions, consistencies, err := fromTestonly()
	if err != nil {
		return nil, err
	}
	moreInclusions, moreConsistencies, err := fromTlog()
	if err != nil {
		return nil, err
	}
	inclusions = append(inclusions, moreInclusions...)
	consistencies = append(consistencies, moreConsistencies...)

	h := rfc6962.DefaultHasher
	for _, c := range inclusions {
		if err := proof.VerifyInclusion(h, c.Index, c.Size, decode(c.Leaf), decodeAll(c.Proof), decode(c.Root)); err != nil {
			return nil, fmt.Errorf("inclusion of %d in %d: %w", c.Index, c.Size, err)
		}
	}
	for _, c := range consistencies {
		if err := proof.VerifyConsistency(h, c.Size1, c.Size2, decodeAll(c.Proof), decode(c.Root1), decode(c.Root2)); err != nil {
			return nil, fmt.Errorf("consistency %d to %d: %w", c.Size1, c.Size2, err)
		}
	}

	var b bytes.Buffer
	b.WriteString("{\n")
	if err := writeArray(&b, "inclusion", inclusions); err != nil {
		return nil, err
	}
	b.WriteString(",\n")
	if err := writeArray(&b, "consistency", consistencies); err != nil {
		return nil, err
	}
	b.WriteString("\n}\n")
	return b.Bytes(), nil
}

// writeArray puts one element per line so a changed vector shows up as a one-line diff.
func writeArray[T any](b *bytes.Buffer, name string, items []T) error {
	fmt.Fprintf(b, "%q: [\n", name)
	for i, item := range items {
		raw, err := json.Marshal(item)
		if err != nil {
			return err
		}
		b.Write(raw)
		if i < len(items)-1 {
			b.WriteByte(',')
		}
		b.WriteByte('\n')
	}
	b.WriteString("]")
	return nil
}

func main() {
	check := flag.Bool("check", false, "fail when the committed fixtures differ from freshly generated ones")
	path := flag.String("out", "../../fixtures/proofs.json", "fixture file")
	flag.Parse()

	want, err := fixtures()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if !*check {
		if err := os.WriteFile(*path, want, 0o644); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	if got, err := os.ReadFile(*path); err != nil || !bytes.Equal(got, want) {
		fmt.Fprintf(os.Stderr, "%s is stale: run go run . in packages/verify/test/go/merkle and commit\n", *path)
		os.Exit(1)
	}
}
