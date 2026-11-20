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
const GENDERS = {
  pt: ["m", "f"],
  fr: ["m", "f"],
  it: ["m", "f"],
  de: ["m", "f", "n"],
} as const satisfies Partial<Record<MeasurementLanguage, readonly Gender[]>>;

/** The languages whose templates agree with the noun: a set in them needs the noun's gender. */
export type GenderedLanguage = keyof typeof GENDERS;

export function isGendered(language: MeasurementLanguage): language is GenderedLanguage {
  return Object.hasOwn(GENDERS, language);
}

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
    // A bare French noun (what a web-only store sells) still elides "de": "d'accessoires".
    return language === "fr" ? joinAll(template, { text: noun, gender: "m" }, language) : template;
  }
  const genders: readonly Gender[] = isGendered(language) ? GENDERS[language] : [];
  if (!genders.includes(noun.gender)) {
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
  return joinAll(resolved, noun, language);
}

function joinAll(template: string, noun: GenderedNoun, language: MeasurementLanguage): string {
  return template
    .split("{sustantivo}")
    .map((part, i, parts) => (i < parts.length - 1 ? joinNoun(part, noun, language) : part))
    .join("{sustantivo}");
}

/**
 * A place and the article its name takes in the language: in Portuguese one the name leaves out
 * ("o" for Rio de Janeiro), in French and Italian the one it starts with ("le" for Le Havre,
 * "il" for Il Cairo).
 */
export type PlaceName = { text: string; article?: string };

export function placeText(place: PlaceName | string): string {
  return typeof place === "string" ? place : place.text;
}

const articled = (forms: readonly string[], articles: readonly string[]) =>
  Object.fromEntries(articles.map((article, i) => [article, forms[i] ?? ""]));
const PORTUGUESE_ARTICLES = ["o", "a", "os", "as"];
const ITALIAN_ARTICLES = ["il", "lo", "la", "l'", "i", "gli", "le"];
// a, di, in, da and su fuse alike: al, allo, alla, all', ai, agli, alle.
const italian = (stem: string) =>
  articled(
    ["l", "llo", "lla", "ll'", "i", "gli", "lle"].map((ending) => `${stem}${ending}`),
    ITALIAN_ARTICLES,
  );

// The preposition and the article fuse; a pair missing here stays apart ("à La Rochelle").
const CONTRACTIONS: Partial<Record<MeasurementLanguage, Record<string, Record<string, string>>>> = {
  pt: {
    em: articled(["no", "na", "nos", "nas"], PORTUGUESE_ARTICLES),
    de: articled(["do", "da", "dos", "das"], PORTUGUESE_ARTICLES),
    a: articled(["ao", "à", "aos", "às"], PORTUGUESE_ARTICLES),
    por: articled(["pelo", "pela", "pelos", "pelas"], PORTUGUESE_ARTICLES),
  },
  fr: { à: { le: "au", les: "aux" }, de: { le: "du", les: "des" } },
  it: {
    a: italian("a"),
    di: italian("de"),
    in: italian("ne"),
    da: italian("da"),
    su: italian("su"),
  },
};

/** The name without its leading article, when it starts with it: "Havre", "Aquila". */
function withoutArticle(text: string, article: string): string | null {
  const head = text.slice(0, article.length);
  if (head.toLowerCase() !== article) return null;
  const rest = text.slice(article.length);
  if (article.endsWith("'")) return rest;
  return rest.startsWith(" ") ? rest.slice(1) : null;
}

/**
 * Fuses the preposition before {lugar} with the place's article: "em {lugar}" is "no Rio de
 * Janeiro", "à {lugar}" is "au Havre", "a {lugar}" is "al Cairo" and "all'Aquila". A place
 * without an article, and a word that fuses with none, keep the template as written.
 */
export function joinPlace(
  template: string,
  place: PlaceName | string,
  language: MeasurementLanguage,
): string {
  if (typeof place === "string" || !place.article) return template;
  const { text, article } = place;
  const fused = CONTRACTIONS[language];
  if (!fused) return template;
  return template.replace(/(\S+)(\s+)\{lugar\}/gu, (match, word: string) => {
    const form = fused[word.toLowerCase()]?.[article];
    if (!form) return match;
    const name = withoutArticle(text, article) ?? text;
    return `${matchCase(word, form)}${form.endsWith("'") ? "" : " "}${name}`;
  });
}
