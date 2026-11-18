// Command go writes the transparency log fixtures that pin @reranker/evidence to the reference
// implementation, golang.org/x/mod/sumdb/tlog. With --check it regenerates them in memory and
// fails when the committed files differ.
//
// The note-verify subcommand reads {"vkey", "note"} as JSON from stdin and opens the signed note
// with golang.org/x/mod/sumdb/note, so checkpoints are checked by an independent implementation.
package main

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"math/bits"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/mod/sumdb/note"
	"golang.org/x/mod/sumdb/tlog"
)

const (
	records    = 1100
	tileHeight = 8
)

type store []tlog.Hash

func (s store) ReadHashes(indexes []int64) ([]tlog.Hash, error) {
	out := make([]tlog.Hash, len(indexes))
	for i, index := range indexes {
		out[i] = s[index]
	}
	return out, nil
}

func recordData(n int64) []byte { return []byte(fmt.Sprintf("reranker tlog record %d", n)) }

func hexes(hashes []tlog.Hash) []string {
	out := make([]string, len(hashes))
	for i, h := range hashes {
		out[i] = hex.EncodeToString(h[:])
	}
	return out
}

type storedHashes struct {
	N        int64    `json:"n"`
	Data     string   `json:"data"`
	Expected []string `json:"expected"`
}

type tree struct {
	N        int64    `json:"n"`
	Root     string   `json:"root"`
	Frontier []string `json:"frontier"`
}

// Record or Tree is null where Go rejects the coordinates.
type proof struct {
	T      int64    `json:"t"`
	N      int64    `json:"n"`
	Record []string `json:"record"`
	Tree   []string `json:"tree"`
}

type tiles struct {
	Old     int64    `json:"old"`
	New     int64    `json:"new"`
	Paths   []string `json:"paths"`
	Entries []string `json:"entries"`
}

// Tree sizes around the 256-entry tile edges and the powers of two where proofs change shape.
var sizes = []int64{1, 2, 3, 4, 5, 7, 8, 9, 16, 17, 31, 32, 33, 255, 256, 257, 511, 512, 513, 767, 768, 1023, 1024, 1025, 1099, 1100}

func fixtures() (map[string]any, error) {
	var s store
	stored := make([]storedHashes, 0, records)
	for n := int64(0); n < records; n++ {
		hashes, err := tlog.StoredHashes(n, recordData(n), s)
		if err != nil {
			return nil, err
		}
		s = append(s, hashes...)
		stored = append(stored, storedHashes{N: n, Data: hex.EncodeToString(recordData(n)), Expected: hexes(hashes)})
	}

	trees := []tree{{N: 0, Root: hex.EncodeToString(mustTreeHash(0, s)), Frontier: []string{}}}
	proofs := []proof{}
	for _, t := range sizes {
		trees = append(trees, tree{N: t, Root: hex.EncodeToString(mustTreeHash(t, s)), Frontier: hexes(frontier(t, s))})
		for _, n := range sample(t) {
			p := proof{T: t, N: n}
			if record, err := tlog.ProveRecord(t, n, s); err == nil {
				p.Record = hexes(record)
			}
			if tree, err := tlog.ProveTree(t, n, s); err == nil {
				p.Tree = hexes(tree)
			}
			proofs = append(proofs, p)
		}
	}

	pairs := [][2]int64{
		{0, 0}, {0, 1}, {0, 255}, {0, 256}, {0, 257}, {1, 1}, {255, 257}, {256, 512}, {1, 1100},
		{1099, 1100}, {0, 70000}, {65535, 65537}, {65536, 65792}, {255900, 256300},
		{1234067 * 256, 1234067*256 + 1}, {1 << 40, 1<<40 + 5},
	}
	tileSets := make([]tiles, 0, len(pairs))
	for _, p := range pairs {
		set := tiles{Old: p[0], New: p[1], Paths: []string{}, Entries: []string{}}
		for _, t := range tlog.NewTiles(tileHeight, p[0], p[1]) {
			set.Paths = append(set.Paths, c2spPath(t))
			if t.L == 0 {
				set.Entries = append(set.Entries, c2spPath(tlog.Tile{H: t.H, L: -1, N: t.N, W: t.W}))
			}
		}
		tileSets = append(tileSets, set)
	}

	return map[string]any{"stored-hashes": stored, "trees": trees, "proofs": proofs, "tiles": tileSets}, nil
}

// sample picks record indexes at both ends of the tree, at its middle and across tile edges,
// including the out-of-range ones Go rejects.
func sample(t int64) []int64 {
	seen := map[int64]bool{}
	out := []int64{}
	for _, n := range []int64{0, 1, t / 2, t - 2, t - 1, t, 255, 256, 257, 1024} {
		if n >= 0 && n <= t && !seen[n] {
			seen[n] = true
			out = append(out, n)
		}
	}
	return out
}

func mustTreeHash(n int64, s store) []byte {
	h, err := tlog.TreeHash(n, s)
	if err != nil {
		panic(err)
	}
	return h[:]
}

// frontier reads the roots of the perfect subtrees that make up a tree of size n, left to right:
// the hashes tlog.TreeHash folds.
func frontier(n int64, s store) []tlog.Hash {
	out := []tlog.Hash{}
	lo := int64(0)
	for level := 63 - bits.LeadingZeros64(uint64(n)); level >= 0; level-- {
		if n&(1<<level) != 0 {
			out = append(out, s[tlog.StoredHashIndex(level, lo>>level)])
			lo += 1 << level
		}
	}
	return out
}

// c2spPath drops the height element that sumdb paths carry: C2SP tlog-tiles fixes it at 8 and
// names the data level "entries".
func c2spPath(t tlog.Tile) string {
	path := t.Path()
	if t.L == -1 {
		return strings.Replace(path, fmt.Sprintf("tile/%d/data/", t.H), "tile/entries/", 1)
	}
	return strings.Replace(path, fmt.Sprintf("tile/%d/", t.H), "tile/", 1)
}

// encode writes one array element per line so a changed vector shows up as a one-line diff.
func encode(v any) ([]byte, error) {
	raw, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	var items []json.RawMessage
	if err := json.Unmarshal(raw, &items); err != nil {
		return nil, err
	}
	var b bytes.Buffer
	b.WriteString("[\n")
	for i, item := range items {
		b.Write(item)
		if i < len(items)-1 {
			b.WriteByte(',')
		}
		b.WriteByte('\n')
	}
	b.WriteString("]\n")
	return b.Bytes(), nil
}

func noteVerify() error {
	var input struct {
		Vkey string `json:"vkey"`
		Note string `json:"note"`
	}
	if err := json.NewDecoder(os.Stdin).Decode(&input); err != nil {
		return err
	}
	verifier, err := note.NewVerifier(input.Vkey)
	if err != nil {
		return err
	}
	known := note.VerifierList(verifier)
	n, err := note.Open([]byte(input.Note), known)
	if err != nil {
		return err
	}
	if len(n.Sigs) != 1 || n.Sigs[0].Name != verifier.Name() {
		return fmt.Errorf("want one signature from %s, got %d", verifier.Name(), len(n.Sigs))
	}
	// A note whose text changed after signing must not open.
	tampered := strings.Replace(input.Note, n.Text, n.Text+"x\n", 1)
	if _, err := note.Open([]byte(tampered), known); err == nil {
		return fmt.Errorf("a tampered note verified")
	}
	return nil
}

func main() {
	// Checked before flag.Parse, which stops at the first non-flag argument.
	if len(os.Args) > 1 && os.Args[1] == "note-verify" {
		if err := noteVerify(); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		fmt.Println("OK")
		return
	}

	check := flag.Bool("check", false, "fail when the committed fixtures differ from freshly generated ones")
	dir := flag.String("dir", "../fixtures/tlog", "fixture directory")
	flag.Parse()

	all, err := fixtures()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	stale := false
	for name, v := range all {
		want, err := encode(v)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		path := filepath.Join(*dir, name+".json")
		if !*check {
			if err := os.WriteFile(path, want, 0o644); err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
			continue
		}
		if got, err := os.ReadFile(path); err != nil || !bytes.Equal(got, want) {
			fmt.Fprintf(os.Stderr, "%s is stale: run go run . in packages/evidence/test/go and commit\n", path)
			stale = true
		}
	}
	if stale {
		os.Exit(1)
	}
}
