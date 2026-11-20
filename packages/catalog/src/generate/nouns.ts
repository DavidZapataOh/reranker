import { readFileSync } from "node:fs";

/** The form the word lists are keyed by: lowercase, without diacritics. */
export function foldNoun(word: string): string {
  return word
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();
}

// Only German writes every common noun with a capital, so only German needs lists to tell a
// noun from a name. Loaded on first use, so no other language pays for them.
const FILES = { de: { nouns: "de-nouns.txt", names: "de-names.txt" } } as const;
export type NounListLanguage = keyof typeof FILES;

type Lists = { nouns: ReadonlySet<string>; names: ReadonlySet<string> };
const loaded = new Map<NounListLanguage, Lists>();

const read = (file: string): ReadonlySet<string> =>
  new Set(
    readFileSync(new URL(`../../data/guards/${file}`, import.meta.url), "utf8")
      .split("\n")
      .filter(Boolean),
  );

function lists(language: NounListLanguage): Lists {
  let found = loaded.get(language);
  if (!found) {
    found = { nouns: read(FILES[language].nouns), names: read(FILES[language].names) };
    loaded.set(language, found);
  }
  return found;
}

export function hasNounList(language: string): language is NounListLanguage {
  return Object.hasOwn(FILES, language);
}

// "Arzt" heads "Zahnarzt"; shorter tails ("Rat", "Tor") would make too many names look like nouns.
const MIN_HEAD = 4;
const MIN_MODIFIER = 3;

// Suffixes that only ever form common nouns ("Spezialisierung", "Erreichbarkeit"), folded.
const NOUN_SUFFIX = /.{3}(?:ung|heit|keit|schaft|tion|itat|ismus|nis)(?:en|e|s|se)?$/u;

function knownHead(folded: string, nouns: ReadonlySet<string>): boolean {
  if (nouns.has(folded) || NOUN_SUFFIX.test(folded)) return true;
  for (let cut = MIN_MODIFIER; cut <= folded.length - MIN_HEAD; cut++) {
    if (nouns.has(folded.slice(cut))) return true;
  }
  return false;
}

/**
 * Whether a capitalized `word` is a common noun: one the list knows as written ("Müller" is a
 * miller too), never a name it knows ("Hamburg"), or a compound whose head noun it knows
 * ("Kinderzahnarzt", "Bio-Bäckerei") or whose suffix only forms nouns ("Spezialisierung").
 * German forms most nouns by compounding and derivation, so no list holds them all; a name built on a common noun that the names list lacks passes here and is left to
 * the judge and the blocked names.
 */
export function isCommonNoun(word: string, language: NounListLanguage): boolean {
  const { nouns, names } = lists(language);
  const folded = foldNoun(word);
  if (nouns.has(folded)) return true;
  if (names.has(folded)) return false;
  const head = folded.split("-").filter(Boolean).at(-1) ?? "";
  return !names.has(head) && knownHead(head, nouns);
}
