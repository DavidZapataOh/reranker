/**
 * Compares the businesses ChatGPT and Gemini recommend across query languages against the
 * run-to-run variation inside one language, from the files record-language.ts writes.
 *
 * Usage: pnpm --filter @reranker/capture analyze:language <recorded dir>
 * Reads only the recorded bytes and writes analysis.json and analysis.md next to them.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseChatGpt } from "../src/dataforseo/parse/chatgpt";
import { parseGemini } from "../src/dataforseo/parse/gemini";

const ENGINES = ["chatgpt", "gemini"] as const;
const CITIES = ["miami", "madrid"] as const;
const QUESTIONS = [
  "dentist-best",
  "dentist-need",
  "restaurant-best",
  "restaurant-need",
  "lawyer-best",
  "lawyer-need",
] as const;
const LANGS = ["en", "es"] as const;
const RUNS = [1, 2, 3] as const;

type Engine = (typeof ENGINES)[number];

// Headings and bold labels that organize an answer instead of naming a business, in both
// languages so neither side is penalized for its own vocabulary.
const GENERIC =
  /^(tips?|consejos?|notes?|notas?|summary|resumen|why|por qu|how|c[oó]mo|what|qu[eé]|where|d[oó]nde|when|cu[aá]ndo|best for|ideal para|mejor para|location|ubicaci[oó]n|address|direcci[oó]n|phone|tel[eé]fono|hours|horario|rating|calificaci[oó]n|reviews?|rese[ñn]as?|price|precio|cost|costo|services?|servicios?|specialt|especialidad|highlights?|destacad|cuisine|cocina|atmosphere|ambiente|vibe|key|clave|final|conclusion|conclusi[oó]n|option|opci[oó]n|other|otros?|more|m[aá]s|top|important|importante|emergency|urgencias?|insurance|seguros?|before|antes|if you|si |for |para |in |en |near|cerca|budget|presupuesto|family|familia|kids|ni[ñn]os|neighborhood|barrio|zona|area|[aá]rea|sources?|fuentes?|recommend|recomend)/i;

// Sections that give advice instead of naming businesses; skipped until the next heading.
const ADVICE =
  /(tips?|consejos?|aspectos|considera|c[oó]mo elegir|how to choose|choosing|elegir|what to|qu[eé] hacer|key|clave|steps|pasos|before you|antes de|faq|preguntas)/i;

// Questions and first-person asides that close an answer ("My recommendation", "¿Qué necesitas?").
const ASIDE =
  /\?|^¿|^(my|mi|mis|let me|quiero|te |if |si |preferred|prefer|tienes|do you|are you|which|cu[aá]l|qu[eé]|en qu[eé]|para qu[eé]|lo que|what|where|d[oó]nde|features|caracter[ií]sticas|bonus|extra|also|tambi[eé]n)\b/i;

// A heading in the plural names a group ("Best dentists in Miami"), not one business.
const SECTION =
  /\b(dentists|dentistas|restaurants|restaurantes|lawyers|abogados|attorneys|practices|cl[ií]nicas|despachos|bufetes|firms|options|opciones|places|lugares|picks)\b/i;

const LEGAL_SUFFIX = /\b(llc|pllc|p ?a|pc|inc|dds|dmd|sl|slp|s ?l ?p)$/;

/** A business name reduced so the same business matches across languages and runs. */
export function normalizeName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[''`´]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/^the /, "")
    .replace(LEGAL_SUFFIX, "")
    .trim();
}

function cleanLabel(raw: string): string | null {
  const label = raw
    // Gemini glues its citation links to the name; a link whose text is a domain is not part of it.
    .replace(/\[([^\]\s]+\.[a-z]{2,})\]\([^)]*\)/gi, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`\\]/g, "")
    .replace(/^\d+[.)]\s*/, "")
    .split(/\s[–—-]\s|:|\s\(|\s\|/)[0]
    ?.trim();
  if (!label || label.length < 2 || label.length > 60) return null;
  if (!/\p{Lu}/u.test(label) || GENERIC.test(label) || ASIDE.test(label)) return null;
  return label;
}

/** Business names in the order the answer gives them: list items led by bold text, or headings. */
export function businessNames(markdown: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let advice = false;
  for (const line of markdown.split("\n")) {
    const heading = line.match(/^#{1,4}\s+(.+)$/)?.[1];
    if (heading !== undefined) advice = ADVICE.test(heading);
    if (advice) continue;
    // Headings mostly group answers by neighborhood or need; only numbered ones name a business.
    const numbered = heading?.match(/^(?:\*\*)?\d+\\?[.)]\s*(.+)$/)?.[1];
    if (heading !== undefined && numbered === undefined) continue;
    const raw =
      numbered ??
      // "- **Name**", "1. **Name**", "**1\. Name**" on its own line, or a table's first cell.
      line.match(/^\s*(?:[-*+]|\d+[.)])\s+\*\*(.+?)\*\*/)?.[1] ??
      line.match(/^\s*\*\*(?:\d+\\?\.\s*)?(.+?)\*\*\s*$/)?.[1] ??
      line.match(/^\|\s*\*\*(.+?)\*\*\s*\|/)?.[1] ??
      "";
    const label = cleanLabel(raw);
    if (!label || (heading !== undefined && SECTION.test(label))) continue;
    const key = normalizeName(label);
    if (key && !seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

export function jaccard(a: string[], b: string[]): number | null {
  const A = new Set(a);
  const B = new Set(b);
  const union = new Set([...A, ...B]).size;
  if (union === 0) return null;
  return [...A].filter((x) => B.has(x)).length / union;
}

/** Rank-biased overlap, extrapolated (Webber, Moffat and Zobel 2010), with p = 0.9. */
export function rbo(a: string[], b: string[], p = 0.9): number | null {
  if (a.length === 0 && b.length === 0) return null;
  const k = Math.max(a.length, b.length);
  const seenA = new Set<string>();
  const seenB = new Set<string>();
  let overlap = 0;
  let sum = 0;
  for (let d = 1; d <= k; d++) {
    const x = a[d - 1];
    const y = b[d - 1];
    if (x !== undefined && x === y) overlap += 1;
    else {
      if (x !== undefined) {
        if (seenB.has(x)) overlap += 1;
        seenA.add(x);
      }
      if (y !== undefined) {
        if (seenA.has(y)) overlap += 1;
        seenB.add(y);
      }
    }
    sum += (overlap / d) * p ** d;
  }
  return (overlap / k) * p ** k + ((1 - p) / p) * sum;
}

/** Spearman's rho over the items both lists share, ranked within each list; null below 3. */
export function spearman(a: string[], b: string[]): number | null {
  const shared = a.filter((x) => b.includes(x));
  const n = shared.length;
  if (n < 3) return null;
  const rb = [...shared].sort((x, y) => b.indexOf(x) - b.indexOf(y));
  const d2 = shared.reduce((t, x, i) => t + (i - rb.indexOf(x)) ** 2, 0);
  return 1 - (6 * d2) / (n * (n * n - 1));
}

const ES_WORDS =
  /\b(de|del|en|el|la|los|las|mejor|mejores|para|con|cerca|abogados?|restaurantes?|dentistas?|urgencias?|cl[ií]nica|accidentes?|tr[aá]fico|tr[aá]nsito|familiar|cena|hoy|y)\b/i;
const EN_WORDS =
  /\b(the|best|in|for|near|of|and|dentists?|lawyers?|attorneys?|restaurants?|emergency|clinic|accident|car|family|dinner|today|top|reviews?)\b/i;

/** "es", "en" or "other" by the language-specific words a search query uses. */
export function queryLanguage(query: string): "es" | "en" | "other" {
  const es = (query.match(new RegExp(ES_WORDS, "gi")) ?? []).length;
  const en = (query.match(new RegExp(EN_WORDS, "gi")) ?? []).length;
  if (es > en) return "es";
  if (en > es) return "en";
  return "other";
}

type Answer = {
  names: string[];
  structured: string[];
  domains: string[];
  queries: string[];
  markdownLength: number;
};

function domainOf(source: { domain: string; title?: string | undefined }): string {
  // Gemini cites through Google redirects; the title carries the site.
  const raw = source.domain.includes("vertexaisearch") ? (source.title ?? "") : source.domain;
  return raw.toLowerCase().replace(/^www\./, "");
}

function read(dir: string, engine: Engine, file: string): Answer | null {
  const path = join(dir, "answers", engine, file);
  if (!existsSync(path)) return null;
  try {
    const answer = (engine === "chatgpt" ? parseChatGpt : parseGemini)(readFileSync(path));
    return {
      names: businessNames(answer.markdown),
      structured: (answer.localBusinesses ?? []).map((b) =>
        normalizeName(b.name.split(/\s[–—-]\s/)[0] ?? b.name),
      ),
      domains: [...new Set(answer.sources.filter((s) => s.cited).map(domainOf))].filter(Boolean),
      queries: Array.isArray(answer.searchQueries) ? answer.searchQueries : [],
      markdownLength: answer.markdown.length,
    };
  } catch {
    return null;
  }
}

const mean = (xs: (number | null)[]): number | null => {
  const v = xs.filter((x): x is number => x !== null);
  return v.length === 0 ? null : v.reduce((t, x) => t + x, 0) / v.length;
};

type Pairs = { within: [Answer, Answer][]; across: [Answer, Answer][] };

/**
 * One spelling per business across a question's answers: a name whose words start another's
 * ("legalcar" and "legalcar abogados") is the same business. Applied to every run alike, so it
 * moves the within-language and across-language overlaps together.
 */
export function canonicalize(answers: { names: string[]; structured: string[] }[]): void {
  const pool = [...new Set(answers.flatMap((a) => [...a.names, ...a.structured]))].sort(
    (a, b) => a.length - b.length,
  );
  const canonical = new Map<string, string>();
  for (const name of pool) {
    const words = name.split(" ");
    const base = pool.find((shorter) => {
      if (shorter.length >= name.length) return false;
      const head = shorter.split(" ");
      const distinctive = head.length >= 2 || (head[0]?.length ?? 0) >= 6;
      return distinctive && head.every((w, i) => words[i] === w);
    });
    canonical.set(name, base === undefined ? name : (canonical.get(base) ?? base));
  }
  const map = (names: string[]) => [...new Set(names.map((n) => canonical.get(n) ?? n))];
  for (const answer of answers) {
    answer.names = map(answer.names);
    answer.structured = map(answer.structured);
  }
}

function pairs(byLang: Record<string, Answer[]>): Pairs {
  const within: [Answer, Answer][] = [];
  for (const lang of LANGS) {
    const runs = byLang[lang] ?? [];
    for (let i = 0; i < runs.length; i++) {
      for (let j = i + 1; j < runs.length; j++) within.push([runs[i] as Answer, runs[j] as Answer]);
    }
  }
  const across: [Answer, Answer][] = [];
  for (const a of byLang.en ?? []) for (const b of byLang.es ?? []) across.push([a, b]);
  return { within, across };
}

type Metric = (a: Answer, b: Answer) => number | null;
const METRICS: Record<string, Metric> = {
  jaccard: (a, b) => jaccard(a.names, b.names),
  rbo: (a, b) => rbo(a.names, b.names),
  spearman: (a, b) => spearman(a.names, b.names),
  domains: (a, b) => jaccard(a.domains, b.domains),
  structured: (a, b) =>
    a.structured.length + b.structured.length === 0 ? null : jaccard(a.structured, b.structured),
};

const fmt = (x: number | null) => (x === null ? "–" : x.toFixed(2));

function main(dir: string) {
  const cells: Record<string, unknown>[] = [];
  const totals: Record<string, { within: (number | null)[]; across: (number | null)[] }> = {};
  const queryLangs: Record<string, Record<string, number>> = {};
  const lines = [
    "| engine | city | question | n en/es | names/answer | Jaccard within | Jaccard across | RBO within | RBO across | domains within | domains across |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const engine of ENGINES) {
    for (const city of CITIES) {
      for (const question of QUESTIONS) {
        const byLang: Record<string, Answer[]> = {};
        for (const lang of LANGS) {
          byLang[lang] = RUNS.flatMap(
            (r) => read(dir, engine, `${city}-${question}-${lang}-r${r}.json`) ?? [],
          );
          for (const answer of byLang[lang] ?? []) {
            const key = `${engine} ${city} prompt-${lang}`;
            queryLangs[key] ??= { es: 0, en: 0, other: 0, sessions: 0, sessionsWithEn: 0 };
            const counts = queryLangs[key];
            counts.sessions = (counts.sessions ?? 0) + (answer.queries.length > 0 ? 1 : 0);
            if (answer.queries.some((q) => queryLanguage(q) === "en")) {
              counts.sessionsWithEn = (counts.sessionsWithEn ?? 0) + 1;
            }
            for (const q of answer.queries) {
              const l = queryLanguage(q);
              counts[l] = (counts[l] ?? 0) + 1;
            }
          }
        }
        canonicalize([...(byLang.en ?? []), ...(byLang.es ?? [])]);
        const { within, across } = pairs(byLang);
        const cell: Record<string, unknown> = {
          engine,
          city,
          question,
          names: Object.fromEntries(LANGS.map((l) => [l, (byLang[l] ?? []).map((a) => a.names)])),
          structured: Object.fromEntries(
            LANGS.map((l) => [l, (byLang[l] ?? []).map((a) => a.structured)]),
          ),
          domains: Object.fromEntries(
            LANGS.map((l) => [l, (byLang[l] ?? []).map((a) => a.domains)]),
          ),
        };
        for (const [name, metric] of Object.entries(METRICS)) {
          const w = within.map(([a, b]) => metric(a, b));
          const x = across.map(([a, b]) => metric(a, b));
          cell[`${name}Within`] = mean(w);
          cell[`${name}Across`] = mean(x);
          for (const key of [`${name}`, `${name} ${engine}`, `${name} ${city}`]) {
            totals[key] ??= { within: [], across: [] };
            totals[key].within.push(...w);
            totals[key].across.push(...x);
          }
        }
        cells.push(cell);
        const all = [...(byLang.en ?? []), ...(byLang.es ?? [])];
        lines.push(
          `| ${engine} | ${city} | ${question} | ${byLang.en?.length}/${byLang.es?.length} | ${fmt(mean(all.map((a) => a.names.length)))} | ${fmt(cell.jaccardWithin as number | null)} | ${fmt(cell.jaccardAcross as number | null)} | ${fmt(cell.rboWithin as number | null)} | ${fmt(cell.rboAcross as number | null)} | ${fmt(cell.domainsWithin as number | null)} | ${fmt(cell.domainsAcross as number | null)} |`,
        );
      }
    }
  }
  const summary = [
    "| metric | pairs within / across | mean within language | mean across languages | gap |",
    "|---|---|---|---|---|",
    ...Object.entries(totals)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, t]) => {
        const w = mean(t.within);
        const x = mean(t.across);
        const n = (xs: (number | null)[]) => xs.filter((v) => v !== null).length;
        return `| ${key} | ${n(t.within)} / ${n(t.across)} | ${fmt(w)} | ${fmt(x)} | ${w === null || x === null ? "–" : (w - x).toFixed(2)} |`;
      }),
  ];
  const fanout = [
    "| engine, city, prompt language | searches es | en | other | sessions with an English search |",
    "|---|---|---|---|---|",
    ...Object.entries(queryLangs).map(
      ([k, c]) => `| ${k} | ${c.es} | ${c.en} | ${c.other} | ${c.sessionsWithEn}/${c.sessions} |`,
    ),
  ];
  const md = [
    "## Overall",
    "",
    ...summary,
    "",
    "## ChatGPT search queries by language",
    "",
    ...fanout,
    "",
    "## Per question",
    "",
    ...lines,
    "",
  ].join("\n");
  writeFileSync(join(dir, "analysis.json"), JSON.stringify({ cells, queryLangs }, null, 2));
  writeFileSync(join(dir, "analysis.md"), md);
  console.log(md);
}

const dir = process.argv[2];
if (!dir) throw new Error("Usage: analyze-language.ts <recorded dir>");
main(resolve(dir));
