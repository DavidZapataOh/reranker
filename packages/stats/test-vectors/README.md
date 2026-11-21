# Statistics test vectors

Reference data that any implementation of this estimator, in any language, must reproduce.

## `intervals.json`

Jeffreys and Wilson bounds and normal quantiles computed with SciPy and statsmodels by
`generate.py` (regeneration command in its docstring). Jeffreys bounds are the raw Beta quantiles;
an implementation pins the lower bound to 0 when `y = 0` and the upper bound to 1 when `y = n`.
Every bound must match to within 1e-9.

## `reports/*.json`

Each file is one free report, input and output:

```json
{
  "methodologyVersion": "2026.11.1",
  "methodologyHash": "<sha256 of methodology/<version>.json canonicalized with RFC 8785>",
  "input": { "reportId": "…", "plan": {…}, "captures": […], "extractions": […], "asOf": "…", "target": {…}, "intentWeights": {…}, "languageShares": {…} },
  "output": { "seed": "…", "target": {…}, "competitors": […], … }
}
```

- `input` is the argument of `computeFreeReportStats` serialized as JSON; `asOf` is its ISO 8601
  string. `intentWeights` is absent when every intent weighs 1. `languageShares`, each language's
  share of the category's searches, is present only when the plan has a second language.
- `output` is its `FreeReportStats`. An implementation must produce JSON equal to it byte for byte
  when serialized with the same key order, as `JSON.stringify` does.
- Every random draw is seeded from the input. With `seed(parts…) = sha256_hex(parts joined by
  U+0000)`, the report seed is `seed(reportId, methodologyHash)` (it is `output.seed`), each
  entity's is `seed(reportId, methodologyHash, entityKey)`, and its scoped ranges add
  `"engine", engineId`, `"intent", intentId`, `"language", language` or `"canonical"`. The
  generator is xoshiro128** whose state is the first 16 bytes of the seed read as four
  little-endian 32-bit words.
- With two languages, a stratum (engine, intent) weighs `W_h = (s_l / k_l) · d_i / Σ d`: `s_l` is
  its language's normalized share, `k_l` the engines included in that language and `d_i` the
  intent's demand weight over the intents of that engine and language. An engine counts in the
  second language with at least `ceil(20 · planned_second / planned_main)` valid answers, and the
  second language must plan at least half the main one's questions per engine. A language with no
  engine left gives its share to the other.

| File | What it covers |
|---|---|
| `seed-local.json` | Seed intent set, city geography, a platform and a directory, failed and absent answers |
| `generated-national.json` | Generated set asked nationally, negative and passing mentions, one engine excluded |
| `template.json` | Template set, unequal intent weights, a recommendation without an order, the same business twice in one answer, chains, professionals, a retried slot |
| `one-engine.json` | Only one engine with valid answers |
| `invisible.json` | The target only mentioned in passing, and an engine that lost a whole intent |
| `second-language.json` | Spanish and English weighted 89 % and 11 %, English on the half-sample floor, an engine that drops out in English only |

The vectors are frozen. `pnpm --filter @reranker/stats vectors:write` writes any that are missing
and leaves matching ones untouched; it refuses to change a published output unless run with
`--force` under a new methodology version, because a different output is a different method.
