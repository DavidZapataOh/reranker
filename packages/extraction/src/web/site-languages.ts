import { MeasurementLanguage } from "@reranker/schema/measurement";
import { franc } from "franc-min";
import { Parser } from "htmlparser2";
import { safeGet } from "./safe-get";

/**
 * The languages a business site shows it serves in. Places (New) has no field for the languages a
 * business serves in (only reviewers' languages, on the Enterprise + Atmosphere SKU), so the site
 * is the business's own signal.
 */
export interface SiteLanguages {
  /** What the markup and headers declare: `<html lang>`, hreflang, Content-Language. */
  declared: MeasurementLanguage[];
  /** What the visible text is written in. */
  detected: MeasurementLanguage[];
  /** What the page says outright, like "Se habla español". */
  stated: MeasurementLanguage[];
}

const PAGE_MAX_BYTES = 524_288;
// Below this franc's trigrams misread a block; a bilingual page's minor language still clears
// a fifth of the text, while a stray translated menu does not.
const MIN_BLOCK_CHARS = 80;
const MIN_SHARE = 0.2;

const ISO_639_3: Record<string, MeasurementLanguage> = {
  spa: "es",
  eng: "en",
  por: "pt",
  fra: "fr",
  deu: "de",
  ita: "it",
};
const ONLY = Object.keys(ISO_639_3);

const HIDDEN = new Set(["script", "style", "noscript", "template", "svg", "head"]);
const BLOCK = new Set([
  "p",
  "div",
  "section",
  "article",
  "main",
  "header",
  "footer",
  "nav",
  "aside",
  "li",
  "ul",
  "ol",
  "table",
  "tr",
  "td",
  "th",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "br",
  "blockquote",
  "form",
  "button",
  "option",
]);

// Folded: lowercase, no diacritics, single spaces.
const STATEMENTS: Record<MeasurementLanguage, readonly string[]> = {
  es: ["se habla espanol", "hablamos espanol", "atencion en espanol"],
  en: ["english spoken", "we speak english"],
  pt: ["falamos portugues", "fala-se portugues"],
  fr: ["on parle francais", "nous parlons francais"],
  de: ["wir sprechen deutsch"],
  it: ["parliamo italiano", "si parla italiano"],
};

const fold = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}-]+/gu, " ");

function languageOf(tag: string | undefined | null): MeasurementLanguage | null {
  if (!tag) return null;
  try {
    const parsed = MeasurementLanguage.safeParse(new Intl.Locale(tag.trim()).language);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function add(list: MeasurementLanguage[], language: MeasurementLanguage | null) {
  if (language !== null && !list.includes(language)) list.push(language);
}

/** The site's languages from its HTML and Content-Language header; only measurement languages. */
export function readSiteLanguages(html: string, contentLanguage?: string | null): SiteLanguages {
  const declared: MeasurementLanguage[] = [];
  const blocks: string[] = [];
  let block = "";
  let hidden = 0;
  const flush = () => {
    const text = block.replace(/\s+/g, " ").trim();
    if (text) blocks.push(text);
    block = "";
  };
  const parser = new Parser(
    {
      onopentag(name, attrs) {
        if (name === "html") add(declared, languageOf(attrs.lang));
        if (name === "link" && attrs.rel?.toLowerCase().split(/\s+/).includes("alternate")) {
          add(declared, languageOf(attrs.hreflang));
        }
        if (name === "meta" && attrs["http-equiv"]?.toLowerCase() === "content-language") {
          for (const tag of attrs.content?.split(",") ?? []) add(declared, languageOf(tag));
        }
        if (HIDDEN.has(name)) hidden++;
        if (BLOCK.has(name)) flush();
      },
      ontext(text) {
        if (hidden === 0) block += text;
      },
      onclosetag(name) {
        if (HIDDEN.has(name)) hidden = Math.max(0, hidden - 1);
        if (BLOCK.has(name)) flush();
      },
    },
    { decodeEntities: true },
  );
  parser.end(html);
  flush();
  for (const tag of contentLanguage?.split(",") ?? []) add(declared, languageOf(tag));

  const chars = new Map<MeasurementLanguage, number>();
  let classified = 0;
  for (const text of blocks) {
    if (text.length < MIN_BLOCK_CHARS) continue;
    const language = ISO_639_3[franc(text, { only: ONLY, minLength: MIN_BLOCK_CHARS })];
    if (language === undefined) continue;
    chars.set(language, (chars.get(language) ?? 0) + text.length);
    classified += text.length;
  }
  const detected = [...chars]
    .filter(([, n]) => n / classified >= MIN_SHARE)
    .sort((a, b) => b[1] - a[1])
    .map(([language]) => language);

  const page = ` ${fold(blocks.join(" "))} `;
  const stated = MeasurementLanguage.options.filter((language) =>
    STATEMENTS[language].some((phrase) => page.includes(` ${phrase} `)),
  );
  return { declared, detected, stated };
}

/** The languages of the site's page at `url`; null when it is refused, fails or is not a 200. */
export async function fetchSiteLanguages(
  url: string,
  opts: { timeoutMs: number },
): Promise<SiteLanguages | null> {
  const page = await safeGet(url, { timeoutMs: opts.timeoutMs, maxBytes: PAGE_MAX_BYTES });
  if (page?.status !== 200) return null;
  return readSiteLanguages(page.body, page.contentLanguage);
}
