import { z } from "@reranker/schema";
import {
  IntentKind,
  type ParaphraseFormat,
  type QuestionScope,
} from "@reranker/schema/measurement";
import lexicons from "../../data/guards/lexicons.json" with { type: "json" };
import { normalizePlaceName } from "../geo/normalize";
import { placeholderShape } from "../templates";

export type GuardName =
  | "placeholder"
  | "category_noun"
  | "proper_name"
  | "qualifier"
  | "length"
  | "personal_data";

export interface Candidate {
  text: string;
  format: ParaphraseFormat;
  generator: "openai" | "gemini" | "template";
}

// Qualifiers are phrases that tie a question to an intent kind: a kind that does not list one
// drifts into another intent by using it. Reviews rank as much as they reassure, so both kinds
// list them; "mejores"/"best" are left out because people use them to ask for any recommendation.
// `capitalized` holds words a language writes in capitals mid-sentence that are never a name.
const GuardLanguage = z.enum(["es", "en", "pt"]);
export type GuardLanguage = z.infer<typeof GuardLanguage>;

const Lexicon = z.object({
  qualifiers: z.partialRecord(IntentKind, z.array(z.string().min(1)).min(1)),
  capitalized: z.array(z.string().min(1)),
});

type FoldedLexicon = {
  qualifiers: Array<[kind: string, phrases: string[]]>;
  capitalized: string[];
};

// Folded once, so the data can be written as people spell it.
function fold(lexicon: z.infer<typeof Lexicon>): FoldedLexicon {
  return {
    qualifiers: Object.entries(lexicon.qualifiers).map(([kind, phrases]) => [
      kind,
      phrases.map(normalizePlaceName),
    ]),
    capitalized: lexicon.capitalized.map(normalizePlaceName),
  };
}

const PARSED = z.record(GuardLanguage, Lexicon).parse(lexicons);
const LEXICONS: Record<GuardLanguage, FoldedLexicon> = {
  es: fold(PARSED.es),
  en: fold(PARSED.en),
  pt: fold(PARSED.pt),
};

export interface GuardContext {
  scope: QuestionScope;
  kind: IntentKind;
  language: GuardLanguage;
  noun: string;
  synonyms: string[];
  countryName: string;
  otherPlaceNames: ReadonlySet<string>;
  blockedNames: ReadonlySet<string>;
}

export type GuardResult = { ok: true } | { ok: false; guard: GuardName };

const PLACEHOLDER = /\{[^{}]*\}/g;
const MIN_WORDS = 3;
const MAX_WORDS = 40;
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/u;
// Seven or more digits, spaced or dotted as people write phones and id numbers ("300 123 4567",
// "1.023.456.789", "123-45-6789").
const LONG_NUMBER = /\d(?:[\s.-]?\d){6,}/u;
const SENTENCE_END = /[.?!:;]$/u;
const OPENING = /^[¿¡"'«“(]+/u;
const LEADING_UPPER = /^\p{Lu}/u;

/** Placeholders cut the text into segments, so no phrase is matched across "{lugar}". */
function segments(text: string): string[] {
  return text
    .split(PLACEHOLDER)
    .map(normalizePlaceName)
    .filter((s) => s.length > 0);
}

function containsPhrase(segs: readonly string[], phrase: string): boolean {
  return segs.some((s) => ` ${s} `.includes(` ${phrase} `));
}

type NameIndex = { names: ReadonlySet<string>; maxWords: number };
const nameIndexes = new WeakMap<ReadonlySet<string>, NameIndex>();

// A country's place list has thousands of names: index it once per set, then look up n-grams.
function nameIndex(raw: ReadonlySet<string>): NameIndex {
  let index = nameIndexes.get(raw);
  if (!index) {
    const names = new Set<string>();
    let maxWords = 0;
    for (const name of raw) {
      const normalized = normalizePlaceName(name);
      if (!normalized) continue;
      names.add(normalized);
      maxWords = Math.max(maxWords, normalized.split(" ").length);
    }
    index = { names, maxWords };
    nameIndexes.set(raw, index);
  }
  return index;
}

function mentionsAny(segs: readonly string[], raw: ReadonlySet<string>): boolean {
  if (raw.size === 0) return false;
  const { names, maxWords } = nameIndex(raw);
  for (const seg of segs) {
    const words = seg.split(" ");
    for (let start = 0; start < words.length; start++) {
      for (let n = 1; n <= maxWords && start + n <= words.length; n++) {
        if (names.has(words.slice(start, start + n).join(" "))) return true;
      }
    }
  }
  return false;
}

// "clínicas odontológicas" names a "clínica odontológica": each noun word, in order, may take a
// plural ending.
function mentionsNoun(segs: readonly string[], phrase: string): boolean {
  const target = normalizePlaceName(phrase).split(" ");
  return segs.some((seg) => {
    const words = seg.split(" ");
    for (let start = 0; start + target.length <= words.length; start++) {
      if (
        target.every((t, k) => {
          const w = words[start + k] ?? "";
          return w.startsWith(t) && w.length - t.length <= 3;
        })
      ) {
        return true;
      }
    }
    return false;
  });
}

function placeOk(text: string, segs: readonly string[], ctx: GuardContext): boolean {
  return placeholderShape(text, ctx.scope) === "ok" && !mentionsAny(segs, ctx.otherPlaceNames);
}

function wordCount(text: string): number {
  return text.split(/\s+/u).filter((w) => /[\p{L}\p{N}{]/u.test(w)).length;
}

function hasPersonalData(text: string): boolean {
  return EMAIL.test(text) || LONG_NUMBER.test(text);
}

function hasProperName(text: string, segs: readonly string[], ctx: GuardContext): boolean {
  if (mentionsAny(segs, ctx.blockedNames)) return true;
  const allowed = new Set<string>(LEXICONS[ctx.language].capitalized);
  for (const phrase of [ctx.countryName, ctx.noun, ...ctx.synonyms]) {
    for (const word of normalizePlaceName(phrase).split(" ")) allowed.add(word);
  }
  const tokens = text.replace(PLACEHOLDER, " {} ").split(/\s+/u).filter(Boolean);
  let sentenceStart = true;
  for (const token of tokens) {
    const opensSentence = OPENING.test(token);
    const word = token.replace(OPENING, "");
    const startsSentence = sentenceStart || opensSentence;
    sentenceStart = SENTENCE_END.test(token);
    if (startsSentence || !LEADING_UPPER.test(word)) continue;
    const normalized = normalizePlaceName(word);
    if (normalized && !allowed.has(normalized)) return true;
  }
  return false;
}

function hasForeignQualifier(text: string, segs: readonly string[], ctx: GuardContext): boolean {
  const table = LEXICONS[ctx.language].qualifiers;
  const own = new Set(table.find(([kind]) => kind === ctx.kind)?.[1]);
  for (const [kind, phrases] of table) {
    if (kind === ctx.kind) continue;
    if (kind === "zone" && text.includes("{zona}")) return true;
    if (phrases.some((p) => !own.has(p) && containsPhrase(segs, p))) return true;
  }
  return false;
}

/**
 * Deterministic checks a generated paraphrase must pass before it costs an embedding: the place
 * shape of its scope, the category's own noun, no names, no qualifier of another intent, a
 * human length and no personal data. Order matters only for which guard gets the blame.
 */
export function guardParaphrase(c: Candidate, ctx: GuardContext): GuardResult {
  const segs = segments(c.text);
  if (!placeOk(c.text, segs, ctx)) return { ok: false, guard: "placeholder" };
  const words = wordCount(c.text);
  if (words < MIN_WORDS || words > MAX_WORDS) return { ok: false, guard: "length" };
  if (hasPersonalData(c.text)) return { ok: false, guard: "personal_data" };
  const named =
    c.text.includes("{sustantivo}") ||
    [ctx.noun, ...ctx.synonyms].some((p) => mentionsNoun(segs, p));
  if (!named) return { ok: false, guard: "category_noun" };
  if (hasProperName(c.text, segs, ctx)) return { ok: false, guard: "proper_name" };
  if (hasForeignQualifier(c.text, segs, ctx)) return { ok: false, guard: "qualifier" };
  return { ok: true };
}
