// Command note writes the signed note fixtures that pin the checkpoint verifier in
// @reranker/verify to the reference implementation, golang.org/x/mod/sumdb/note. Every note is
// signed by Go and carries the verdict note.Open gives it with the log key as the only known key.
// With --check it regenerates them in memory and fails when the committed file differs.
package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"strings"

	"golang.org/x/mod/sumdb/note"
)

const (
	production = "log.reranker.co/captures/2026"
	preview    = "log-preview.reranker.co/pr-123/br-misty-sun-a1b2c3/captures/2026"
)

type key struct {
	vkey   string
	signer note.Signer
	public ed25519.PublicKey
}

// newKey derives the key from a fixed seed so the fixtures are reproducible: Ed25519 signing is
// deterministic.
func newKey(name, label string) key {
	seed := sha256.Sum256([]byte("reranker note fixture " + label))
	public := ed25519.NewKeyFromSeed(seed[:]).Public().(ed25519.PublicKey)
	vkey, err := note.NewEd25519VerifierKey(name, public)
	if err != nil {
		panic(err)
	}
	hash := strings.Split(vkey, "+")[1]
	skey := "PRIVATE+KEY+" + name + "+" + hash + "+" + base64.StdEncoding.EncodeToString(append([]byte{1}, seed[:]...))
	signer, err := note.NewSigner(skey)
	if err != nil {
		panic(err)
	}
	return key{vkey: vkey, signer: signer, public: public}
}

type fixture struct {
	Name      string `json:"name"`
	Origin    string `json:"origin"`
	Vkey      string `json:"vkey"`
	PublicKey string `json:"publicKey"`
	Note      string `json:"note"`
	// Go is note.Open's verdict: ok, unverified, invalid_signature or malformed.
	Go string `json:"go"`
}

func checkpoint(origin, size string, extensions ...string) string {
	root := sha256.Sum256([]byte("reranker checkpoint " + size))
	lines := append([]string{origin, size, base64.StdEncoding.EncodeToString(root[:])}, extensions...)
	return strings.Join(lines, "\n") + "\n"
}

func sign(text string, signers ...note.Signer) string {
	msg, err := note.Sign(&note.Note{Text: text}, signers...)
	if err != nil {
		panic(err)
	}
	return string(msg)
}

func verdict(msg, vkey string) string {
	verifier, err := note.NewVerifier(vkey)
	if err != nil {
		panic(err)
	}
	_, err = note.Open([]byte(msg), note.VerifierList(verifier))
	var unverified *note.UnverifiedNoteError
	var invalid *note.InvalidSignatureError
	switch {
	case err == nil:
		return "ok"
	case errors.As(err, &unverified):
		return "unverified"
	case errors.As(err, &invalid):
		return "invalid_signature"
	case err.Error() == "malformed note":
		return "malformed"
	}
	panic(err)
}

// splice keeps the text of a and puts the signature block of b under it.
func splice(a, b string) string {
	return a[:strings.LastIndex(a, "\n\n")] + b[strings.LastIndex(b, "\n\n"):]
}

func fixtures() []fixture {
	prod := newKey(production, "production log")
	prev := newKey(preview, "preview log")
	rogue := newKey(production, "rogue log")
	witness := newKey("witness.example/w1", "witness")

	valid := sign(checkpoint(production, "1240"), prod.signer)
	cases := []struct {
		name, origin string
		log          key
		note         string
	}{
		{"production checkpoint", production, prod, valid},
		{"preview checkpoint", preview, prev, sign(checkpoint(preview, "7"), prev.signer)},
		{"empty tree", production, prod, sign(checkpoint(production, "0"), prod.signer)},
		{"extension line", production, prod, sign(checkpoint(production, "1240", "ext"), prod.signer)},
		{"cosigned by an unknown witness", production, prod, sign(checkpoint(production, "1240"), witness.signer, prod.signer)},
		{"same name, unknown key id", production, prod, sign(checkpoint(production, "1240"), rogue.signer, prod.signer)},
		{"only an unknown key", production, prod, sign(checkpoint(production, "1240"), rogue.signer)},
		{"only an unknown witness", production, prod, sign(checkpoint(production, "1240"), witness.signer)},
		{"text changed after signing", production, prod, strings.Replace(valid, "\n1240\n", "\n1241\n", 1)},
		{"signature from another note", production, prod, splice(valid, sign(checkpoint(production, "1241"), prod.signer))},
		{"no signature block", production, prod, checkpoint(production, "1240")},
		{"control character", production, prod, strings.Replace(valid, "\n1240\n", "\n1240\r\n", 1)},
		{"leading zero in size", production, prod, sign(checkpoint(production, "01240"), prod.signer)},
		{"non-decimal size", production, prod, sign(checkpoint(production, "12a"), prod.signer)},
		{"root is not 32 bytes", production, prod, sign(production+"\n1240\nAAAA\n", prod.signer)},
		{"empty extension line", production, prod, sign(checkpoint(production, "1240", "", "ext"), prod.signer)},
		{"two lines", production, prod, sign(production+"\n1240\n", prod.signer)},
		{"another origin", production, prod, sign(checkpoint("log.example.org/other", "1240"), prod.signer)},
	}
	out := make([]fixture, 0, len(cases))
	for _, c := range cases {
		out = append(out, fixture{
			Name:      c.name,
			Origin:    c.origin,
			Vkey:      c.log.vkey,
			PublicKey: base64.StdEncoding.EncodeToString(c.log.public),
			Note:      c.note,
			Go:        verdict(c.note, c.log.vkey),
		})
	}
	return out
}

// encode indents the way Biome formats JSON, so the committed file passes both checks.
func encode(all []fixture) ([]byte, error) {
	out, err := json.MarshalIndent(all, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(out, '\n'), nil
}

func main() {
	check := flag.Bool("check", false, "fail when the committed fixtures differ from freshly generated ones")
	path := flag.String("file", "../../fixtures/notes.json", "fixture file")
	flag.Parse()

	want, err := encode(fixtures())
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
		fmt.Fprintf(os.Stderr, "%s is stale: run go run . in packages/verify/test/go/note and commit\n", *path)
		os.Exit(1)
	}
}
