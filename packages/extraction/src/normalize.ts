import { createHmac } from "node:crypto";
import { defineEnv } from "@reranker/env";
import type { EntityKind } from "@reranker/schema/measurement";
import { extractionEnv } from "./env";

const MARKS = /\p{M}/gu;
// A period right after a lone letter belongs to an initialism ("S.A.S.", "E.U."), so it joins
// the letters; any other period separates words ("rappi.com", "Dra.Ana").
const INITIAL_PERIOD = /(?<![\p{L}\p{N}])(\p{L})\./gu;
const NON_WORD = /[^\p{L}\p{N}]+/gu;
const LEGAL_FORMS = new Set(["sas", "ltda", "eu", "sa"]);
const TITLES = new Set(["dr", "dra"]);

/** Folds a name to the key two extractors and Places must agree on; category words stay. */
export function normalizeName(name: string, kind?: EntityKind): string {
  const tokens = name
    .normalize("NFD")
    .replace(MARKS, "")
    .toLowerCase()
    .replace(INITIAL_PERIOD, "$1")
    .replace(NON_WORD, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  if (kind === "professional") {
    while (tokens.length > 1 && TITLES.has(tokens[0] as string)) tokens.shift();
  }
  while (tokens.length > 1 && LEGAL_FORMS.has(tokens.at(-1) as string)) tokens.pop();
  return tokens.join(" ");
}

export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  const s = Array.from(a);
  const t = Array.from(b);
  if (s.length === 0 || t.length === 0) return 0;

  const window = Math.max(0, Math.floor(Math.max(s.length, t.length) / 2) - 1);
  const sMatched = new Array<boolean>(s.length).fill(false);
  const tMatched = new Array<boolean>(t.length).fill(false);
  let matches = 0;
  for (let i = 0; i < s.length; i++) {
    const from = Math.max(0, i - window);
    const to = Math.min(t.length - 1, i + window);
    for (let j = from; j <= to; j++) {
      if (tMatched[j] || s[i] !== t[j]) continue;
      sMatched[i] = true;
      tMatched[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;

  let halfTranspositions = 0;
  let k = 0;
  for (let i = 0; i < s.length; i++) {
    if (!sMatched[i]) continue;
    while (!tMatched[k]) k++;
    if (s[i] !== t[k]) halfTranspositions++;
    k++;
  }
  const jaro =
    (matches / s.length + matches / t.length + (matches - halfTranspositions / 2) / matches) / 3;

  let prefix = 0;
  while (prefix < 4 && prefix < s.length && prefix < t.length && s[prefix] === t[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

/** True when every token of the name with fewer tokens appears in the other. */
export function tokenContainment(a: string, b: string): boolean {
  const ta = a.split(" ").filter(Boolean);
  const tb = b.split(" ").filter(Boolean);
  const [shorter, longer] = ta.length <= tb.length ? [ta, new Set(tb)] : [tb, new Set(ta)];
  return shorter.length > 0 && shorter.every((token) => longer.has(token));
}

// Hashing a name needs only this key, not every provider key of the package.
const hmacKeyEnv = extractionEnv.pick({ ENTITY_NAME_HMAC_KEY: true });
let hmacKey: Buffer | undefined;

/** Professionals' names reach the public panel only as this keyed hash. */
export function nameHmac(nameNorm: string): string {
  hmacKey ??= Buffer.from(defineEnv([hmacKeyEnv]).ENTITY_NAME_HMAC_KEY, "base64url");
  return createHmac("sha256", hmacKey).update(nameNorm).digest("hex");
}
