import { AppError } from "@reranker/schema";
import type { MeasurementLanguage } from "@reranker/schema/measurement";

export type Gender = "m" | "f" | "n";

/**
 * A noun with the grammar its words agree with. `elides` overrides the spelling rule for the
 * elided forms (l', d', un'): French writes "l'hôtel" but "le hamburger".
 */
export type GenderedNoun = { text: string; gender: Gender; elides?: boolean };

/** What fills {sustantivo}: Spanish and English templates never agree with it, so a bare string. */
export type Noun = string | GenderedNoun;

export function nounText(noun: Noun): string {
  return typeof noun === "string" ? noun : noun.text;
}

// The genders an agreement group lists, in order: "{un bon|une bonne}", "{einen|eine|ein}".
const GENDERS: Partial<Record<MeasurementLanguage, readonly Gender[]>> = {
  pt: ["m", "f"],
  fr: ["m", "f"],
  it: ["m", "f"],
  de: ["m", "f", "n"],
};

/** "{un bon|une bonne}": two or more alternatives, none empty. */
export const AGREEMENT = /\{([^{}|]+(?:\|[^{}|]+)+)\}/g;

export function isAgreementGroup(name: string): boolean {
  const alternatives = name.split("|");
  return alternatives.length >= 2 && alternatives.every((a) => a.length > 0);
}

const internal = (detail: string) => new AppError("internal", { detail });

type Form = { word: string; elided: boolean };

// French elides le, la, de and que before a vowel or a mute h, and du, au and ce change form.
const FRENCH: Record<string, string> = {
  le: "l'",
  la: "l'",
  de: "d'",
  que: "qu'",
  du: "de l'",
  au: "à l'",
  ce: "cet ",
};

// Italian articles and articulated prepositions, by the noun's first sound: the template writes
// the form used before a plain consonant.
const ITALIAN_MASCULINE: Record<string, { lo: string; vowel: string }> = {
  il: { lo: "lo ", vowel: "l'" },
  un: { lo: "uno ", vowel: "un " },
  del: { lo: "dello ", vowel: "dell'" },
  nel: { lo: "nello ", vowel: "nell'" },
  al: { lo: "allo ", vowel: "all'" },
  dal: { lo: "dallo ", vowel: "dall'" },
  sul: { lo: "sullo ", vowel: "sull'" },
};
const ITALIAN_FEMININE: Record<string, string> = {
  la: "l'",
  una: "un'",
  della: "dell'",
  nella: "nell'",
  alla: "all'",
  dalla: "dall'",
  sulla: "sull'",
};

const VOWEL = /^[aeiouàâäéèêëíìîïóòôöúùûüœæ]/i;

function startsWithVowel(noun: GenderedNoun, hCounts: boolean): boolean {
  if (noun.elides !== undefined) return noun.elides;
  return VOWEL.test(noun.text) || (hCounts && /^h[aeiou]/i.test(noun.text));
}

// s + consonant, z, gn, ps, pn, x, y and i + vowel take "lo" and "uno".
const ITALIAN_LO = /^(s[^aeiouàèéìòù]|z|gn|ps|pn|x|y|i[aeiou])/i;

function matchCase(source: string, target: string): string {
  return source[0] === source[0]?.toUpperCase()
    ? (target[0]?.toUpperCase() ?? "") + target.slice(1)
    : target;
}

function frenchForm(word: string, noun: GenderedNoun): Form | null {
  const elided = FRENCH[word.toLowerCase()];
  if (!elided || !startsWithVowel(noun, false)) return null;
  return { word: matchCase(word, elided.trimEnd()), elided: !elided.endsWith(" ") };
}

function italianForm(word: string, noun: GenderedNoun): Form | null {
  const lower = word.toLowerCase();
  const vowel = startsWithVowel(noun, true);
  const masculine = noun.gender === "m" ? ITALIAN_MASCULINE[lower] : undefined;
  const feminine = noun.gender === "f" ? ITALIAN_FEMININE[lower] : undefined;
  const form = masculine
    ? vowel
      ? masculine.vowel
      : ITALIAN_LO.test(noun.text)
        ? masculine.lo
        : null
    : feminine && vowel
      ? feminine
      : null;
  if (form === null) return null;
  return { word: matchCase(word, form.trimEnd()), elided: !form.endsWith(" ") };
}

/** The word right before the noun, changed to the form its first sound takes. */
function joinNoun(before: string, noun: GenderedNoun, language: MeasurementLanguage): string {
  const match = /(\S+)(\s+)$/u.exec(before);
  if (!match?.[1]) return before;
  const word = match[1];
  const form =
    language === "fr" ? frenchForm(word, noun) : language === "it" ? italianForm(word, noun) : null;
  if (!form) return before;
  const head = before.slice(0, match.index);
  return form.elided ? `${head}${form.word}` : `${head}${form.word} `;
}

/**
 * Resolves the agreement groups of a template for its noun, then the article or preposition that
 * changes with the noun's first sound: "{le|la} {sustantivo}" is "le dentiste", "la boulangerie"
 * and "l'hôtel"; "{nel|nella} {sustantivo}" is "nello studio" and "nell'hotel". The other
 * placeholders are left for `instantiate`.
 */
export function agree(template: string, noun: Noun, language: MeasurementLanguage): string {
  const hasGroups = template.search(AGREEMENT) !== -1;
  if (typeof noun === "string") {
    if (hasGroups) throw internal(`a template that agrees with its noun needs its gender`);
    return template;
  }
  const genders = GENDERS[language];
  if (!genders?.includes(noun.gender)) {
    throw internal(`${language} nouns have no ${noun.gender} gender`);
  }
  // German writes every noun with a capital.
  if (language === "de" && !/^\p{Lu}/u.test(noun.text)) {
    throw internal(`German noun "${noun.text}" is not capitalized`);
  }
  const resolved = template.replace(AGREEMENT, (_, group: string) => {
    const alternatives = group.split("|");
    if (alternatives.length !== genders.length) {
      throw internal(`{${group}} needs one form per ${language} gender`);
    }
    return alternatives[genders.indexOf(noun.gender)] ?? "";
  });
  return resolved
    .split("{sustantivo}")
    .map((part, i, parts) => (i < parts.length - 1 ? joinNoun(part, noun, language) : part))
    .join("{sustantivo}");
}
