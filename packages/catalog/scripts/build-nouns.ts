// Rebuilds data/guards/de-nouns.txt and de-names.txt: the German common nouns and proper names
// the English and German Wiktionaries list (lemmas and declined forms, from kaikki.org's
// wiktextract dumps), kept when people actually write them in the OpenSubtitles 2018 frequency
// list. The guard reads them to tell a capitalized common noun from a name.
// Usage: pnpm --filter @reranker/catalog nouns:build
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { foldNoun } from "../src/generate/nouns.ts";

const KAIKKI = "https://kaikki.org/dictionary";
const WIKTIONARY = "CC BY-SA 4.0 and GFDL (Wiktionary, extracted by wiktextract)";
const SOURCES = {
  enNouns: {
    url: `${KAIKKI}/German/pos-noun/kaikki.org-dictionary-German-by-pos-noun.jsonl`,
    license: WIKTIONARY,
  },
  enNames: {
    url: `${KAIKKI}/German/pos-name/kaikki.org-dictionary-German-by-pos-name.jsonl`,
    license: WIKTIONARY,
  },
  // The German Wiktionary also lists the nouns the English one lacks ("Ranking").
  deWiktionary: { url: `${KAIKKI}/downloads/de/de-extract.jsonl.gz`, license: WIKTIONARY },
  frequency: {
    url: "https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/de/de_full.txt",
    license: "CC BY-SA 4.0 (FrequencyWords content, from OpenSubtitles 2018)",
  },
} as const;
// Nouns seen three times or more keep the list near 1 MB; compounds and derivations past it are
// recognized by their head and suffix. Any name seen once counts: a missed name is a leak.
const MIN_NOUN_COUNT = 3;
const MIN_NAME_COUNT = 1;
const OUT = new URL("../data/guards/", import.meta.url);
// Table headers and template names that wiktextract lists among an entry's forms.
const NOT_FORMS = new Set(["table-tags", "inflection-template", "class"]);

async function download(url: string, dir: string): Promise<{ path: string; sha256: string }> {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`${url}: HTTP ${response.status}`);
  const path = join(dir, url.split("/").at(-1) ?? "download");
  const hash = createHash("sha256");
  const body = Readable.fromWeb(response.body);
  body.on("data", (chunk: Buffer) => hash.update(chunk));
  await pipeline(body, createWriteStream(path));
  return { path, sha256: hash.digest("hex") };
}

function lines(path: string) {
  const file = createReadStream(path);
  const input = path.endsWith(".gz") ? file.pipe(createGunzip()) : file;
  input.setEncoding("utf8");
  return createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
}

type Entry = {
  word: string;
  pos?: string;
  lang_code?: string;
  forms?: Array<{ form?: string; tags?: string[] }>;
};

// Capitalized single words; a form with a space is a phrase ("des Hauses").
const isWordForm = (form: string) => /^\p{Lu}/u.test(form) && !/\s/u.test(form);

function addForms(entry: Entry, into: Set<string>): void {
  const forms = [entry.word];
  for (const f of entry.forms ?? []) {
    if (f.form && !f.tags?.some((t) => NOT_FORMS.has(t))) forms.push(f.form);
  }
  for (const form of forms) if (isWordForm(form)) into.add(foldNoun(form));
}

async function collect(path: string, route: (e: Entry) => Set<string> | undefined) {
  for await (const line of lines(path)) {
    const entry = JSON.parse(line) as Entry;
    const into = route(entry);
    if (into) addForms(entry, into);
  }
}

const listed = (words: ReadonlySet<string>, counts: ReadonlyMap<string, number>, min: number) =>
  `${[...words]
    .filter((w) => (counts.get(w) ?? 0) >= min)
    .sort()
    .join("\n")}\n`;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const count = (text: string) => text.split("\n").filter(Boolean).length;

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "nouns-"));
  try {
    const downloads = Object.fromEntries(
      await Promise.all(
        Object.entries(SOURCES).map(async ([key, s]) => [key, await download(s.url, dir)] as const),
      ),
    ) as Record<keyof typeof SOURCES, { path: string; sha256: string }>;

    const counts = new Map<string, number>();
    for await (const line of lines(downloads.frequency.path)) {
      const at = line.lastIndexOf(" ");
      const word = foldNoun(line.slice(0, at));
      counts.set(word, (counts.get(word) ?? 0) + Number(line.slice(at + 1)));
    }
    const nouns = new Set<string>();
    const names = new Set<string>();
    await collect(downloads.enNouns.path, () => nouns);
    await collect(downloads.enNames.path, () => names);
    await collect(downloads.deWiktionary.path, (e) =>
      e.lang_code !== "de"
        ? undefined
        : e.pos === "noun"
          ? nouns
          : e.pos === "name"
            ? names
            : undefined,
    );

    const files = {
      "de-nouns.txt": listed(nouns, counts, MIN_NOUN_COUNT),
      "de-names.txt": listed(names, counts, MIN_NAME_COUNT),
    };
    for (const [name, text] of Object.entries(files)) writeFileSync(new URL(name, OUT), text);
    const manifest = {
      retrievedAt: new Date().toISOString().slice(0, 10),
      license: "CC BY-SA 4.0",
      minCount: { nouns: MIN_NOUN_COUNT, names: MIN_NAME_COUNT },
      sources: Object.entries(SOURCES).map(([key, s]) => ({
        ...s,
        sha256: downloads[key as keyof typeof SOURCES].sha256,
      })),
      files: Object.fromEntries(
        Object.entries(files).map(([name, text]) => [
          name,
          { entries: count(text), sha256: sha256(text) },
        ]),
      ),
    };
    writeFileSync(new URL("de-words.json", OUT), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(manifest.files);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

await main();
