import { createHmac } from "node:crypto";
import { defineEnv } from "@reranker/env";
import type { EntityKind } from "@reranker/schema/measurement";
import { extractionEnv } from "./env";

const MARKS = /\p{M}/gu;
// A period right after a lone letter belongs to an initialism ("S.A.S.", "S. A. S.", "E.U."), so
// it joins the letters; any other period separates words ("rappi.com", "Dra.Ana").
const INITIAL_PERIOD = /(?<![\p{L}\p{N}])(\p{L})\.(?:\s+(?=\p{L}\.))?/gu;
const NON_WORD = /[^\p{L}\p{N}]+/gu;
// Listings append a professional's specialty after a separator: "Dra. Ana Gómez - Odontóloga".
// A hyphen inside a word ("Gómez-Restrepo") is part of the name.
const DESCRIPTOR_SEPARATOR = /\s[-–—]\s|[|·•,(/]/u;

export interface NameRules {
  legalForms: readonly (readonly string[])[];
  professionalTitles: readonly string[];
}

/**
 * The words two spellings of one entity may differ by. Every comparison folds both of its sides
 * with these rules, and the extractor config hashes them, so changing them is a new method.
 */
export const NAME_RULES: NameRules = {
  // Trailing token sequences, longer ones before the forms they end with.
  legalForms: [
    ["sapi", "de", "cv"],
    ["s", "de", "rl", "de", "cv"],
    ["s", "de", "rl"],
    ["sa", "de", "cv"],
    ["s", "en", "c"],
    ["y", "cia"],
    ["sas"],
    ["sa"],
    ["saa"],
    ["sac"],
    ["sca"],
    ["ltda"],
    ["eu"],
    ["eirl"],
    ["srl"],
    ["sl"],
    ["slu"],
    ["cia"],
    ["llc"],
    ["inc"],
    ["ltd"],
  ],
  // Honorifics, degrees and professions listed around a professional's name, at either end.
  professionalTitles: [
    "dr",
    "dra",
    "doctor",
    "doctora",
    "prof",
    "profesor",
    "profesora",
    "lic",
    "licenciado",
    "licenciada",
    "ing",
    "ingeniero",
    "ingeniera",
    "abg",
    "abogado",
    "abogada",
    "psic",
    "psicologo",
    "psicologa",
    "odontologo",
    "odontologa",
    "ortodoncista",
    "medico",
    "medica",
    "nutricionista",
    "fisioterapeuta",
    "dentista",
    "dentist",
    "md",
    "dds",
    "phd",
  ],
};

const TITLES: ReadonlySet<string> = new Set(NAME_RULES.professionalTitles);

function foldWords(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(MARKS, "")
    .toLowerCase()
    .replace(INITIAL_PERIOD, "$1")
    .replace(NON_WORD, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

function dropLegalForms(tokens: string[]): void {
  for (;;) {
    const form = NAME_RULES.legalForms.find(
      (f) => tokens.length > f.length && f.every((word, i) => tokens.at(i - f.length) === word),
    );
    if (form === undefined) return;
    tokens.splice(-form.length);
  }
}

// The first segment that still names someone once titles go; a title alone stays a name.
function personTokens(name: string): string[] {
  let first: string[] | undefined;
  for (const segment of name.split(DESCRIPTOR_SEPARATOR)) {
    const tokens = foldWords(segment);
    if (tokens.length === 0) continue;
    first ??= [...tokens];
    while (tokens.length > 0 && TITLES.has(tokens[0] as string)) tokens.shift();
    while (tokens.length > 0 && TITLES.has(tokens.at(-1) as string)) tokens.pop();
    if (tokens.length > 0) return tokens;
  }
  return first ?? [];
}

/** Folds free text such as a location or an address: accents, case and punctuation only. */
export function normalizeText(text: string): string {
  return foldWords(text).join(" ");
}

/**
 * Folds a name to the key two extractors and Places must agree on; category words stay. The kind
 * is required because both sides of a comparison must fold alike: only a professional's titles
 * are noise.
 */
export function normalizeName(name: string, kind: EntityKind): string {
  const tokens = kind === "professional" ? personTokens(name) : foldWords(name);
  dropLegalForms(tokens);
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
