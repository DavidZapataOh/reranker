package main

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"golang.org/x/mod/sumdb/note"
	"golang.org/x/mod/sumdb/tlog"
)

// tileFetcher reads C2SP tlog-tiles over HTTP for tlog.TileHashReader, which authenticates every
// tile it returns against the checkpoint's tree hash.
type tileFetcher struct {
	prefix string
	client *http.Client
}

func (f tileFetcher) get(path string) ([]byte, error) {
	resp, err := f.client.Get(f.prefix + "/" + path)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GET %s: %s", path, resp.Status)
	}
	return io.ReadAll(resp.Body)
}

func (f tileFetcher) Height() int { return tileHeight }

func (f tileFetcher) ReadTiles(tiles []tlog.Tile) ([][]byte, error) {
	out := make([][]byte, len(tiles))
	for i, t := range tiles {
		data, err := f.get(c2spPath(t))
		if err != nil {
			return nil, err
		}
		out[i] = data
	}
	return out, nil
}

func (f tileFetcher) SaveTiles([]tlog.Tile, [][]byte) {}

// tilesVerify opens the checkpoint served at prefix with vkey, recomputes its root from the
// published hash tiles and checks every entry bundle against the level-0 tiles. It returns the
// tree size.
func tilesVerify(prefix, vkey string) (int64, error) {
	f := tileFetcher{prefix: strings.TrimSuffix(prefix, "/"), client: &http.Client{Timeout: 30 * time.Second}}
	raw, err := f.get("checkpoint")
	if err != nil {
		return 0, err
	}
	verifier, err := note.NewVerifier(vkey)
	if err != nil {
		return 0, err
	}
	n, err := note.Open(raw, note.VerifierList(verifier))
	if err != nil {
		return 0, err
	}
	// c2sp.org/tlog-checkpoint: origin, tree size and base64 root hash, then optional extensions.
	lines := strings.SplitN(n.Text, "\n", 4)
	if len(lines) < 4 {
		return 0, fmt.Errorf("the checkpoint has %d lines", len(lines))
	}
	// c2sp.org/tlog-tiles: the origin is the prefix without its scheme, and names the log key.
	if origin := lines[0]; !strings.HasSuffix(f.prefix, "://"+origin) || origin != verifier.Name() {
		return 0, fmt.Errorf("checkpoint origin %q is not %s nor key %s", origin, f.prefix, verifier.Name())
	}
	size, err := strconv.ParseInt(lines[1], 10, 64)
	if err != nil {
		return 0, err
	}
	rootBytes, err := base64.StdEncoding.DecodeString(lines[2])
	if err != nil || len(rootBytes) != tlog.HashSize {
		return 0, fmt.Errorf("checkpoint root %q is not a hash", lines[2])
	}
	var root tlog.Hash
	copy(root[:], rootBytes)

	reader := tlog.TileHashReader(tlog.Tree{N: size, Hash: root}, f)
	got, err := tlog.TreeHash(size, reader)
	if err != nil {
		return 0, err
	}
	if got != root {
		return 0, fmt.Errorf("the tiles hash to %x, the checkpoint says %x", got, root)
	}

	for start := int64(0); start < size; start += 1 << tileHeight {
		width := min(size-start, 1<<tileHeight)
		tile := tlog.Tile{H: tileHeight, L: 0, N: start >> tileHeight, W: int(width)}
		leaves, err := tlog.ReadTileData(tile, reader)
		if err != nil {
			return 0, err
		}
		bundle, err := f.get(c2spPath(tlog.Tile{H: tileHeight, L: -1, N: tile.N, W: tile.W}))
		if err != nil {
			return 0, err
		}
		// Big-endian uint16 length-prefixed entries, each hashing to its leaf.
		for i := int64(0); i < width; i++ {
			if len(bundle) < 2 || len(bundle) < 2+int(binary.BigEndian.Uint16(bundle)) {
				return 0, fmt.Errorf("entry bundle %d ends before entry %d", tile.N, start+i)
			}
			length := int(binary.BigEndian.Uint16(bundle))
			leaf := tlog.RecordHash(bundle[2 : 2+length])
			if !bytes.Equal(leaf[:], leaves[i*tlog.HashSize:(i+1)*tlog.HashSize]) {
				return 0, fmt.Errorf("entry %d does not hash to its leaf", start+i)
			}
			bundle = bundle[2+length:]
		}
		if len(bundle) != 0 {
			return 0, fmt.Errorf("entry bundle %d has %d trailing bytes", tile.N, len(bundle))
		}
	}
	return size, nil
}
