import { server } from "@reranker/testing/msw";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { fetchSiteLanguages, readSiteLanguages } from "../../src/web/site-languages";

const dns = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: dns.lookup, default: { lookup: dns.lookup } }));

const TEXT = {
  es: "Somos una clínica odontológica familiar con más de veinte años de experiencia. Atendemos urgencias, ortodoncia y limpiezas para toda la familia, con citas el mismo día y precios claros.",
  en: "We are a family dental practice with more than twenty years of experience. We see emergencies, orthodontics and cleanings for the whole family, with same-day appointments and clear prices.",
  pt: "Somos uma clínica odontológica familiar com mais de vinte anos de experiência. Atendemos urgências, ortodontia e limpezas para toda a família, com consultas no mesmo dia e preços claros.",
  fr: "Nous sommes un cabinet dentaire familial avec plus de vingt ans d'expérience. Nous recevons les urgences, l'orthodontie et les détartrages pour toute la famille, avec des rendez-vous le jour même.",
  de: "Wir sind eine familiäre Zahnarztpraxis mit mehr als zwanzig Jahren Erfahrung. Wir behandeln Notfälle, Kieferorthopädie und Zahnreinigungen für die ganze Familie, mit Terminen noch am selben Tag.",
  it: "Siamo uno studio dentistico di famiglia con più di vent'anni di esperienza. Trattiamo urgenze, ortodonzia e pulizie per tutta la famiglia, con appuntamenti in giornata e prezzi chiari.",
} as const;

const page = (lang: string, body: string, head = "") =>
  `<!doctype html><html lang="${lang}"><head><title>x</title>${head}</head><body>${body}</body></html>`;

test.each(Object.entries(TEXT))("a page declared and written in %s", (language, text) => {
  expect(readSiteLanguages(page(language, `<main><p>${text}</p></main>`))).toEqual({
    declared: [language],
    detected: [language],
    stated: [],
  });
});

test("a Miami dentist in English that says it speaks Spanish in its footer", () => {
  const html = page(
    "en-US",
    `<main><p>${TEXT.en}</p><p>${TEXT.en}</p></main><footer>¡Se habla Español!</footer>`,
  );
  expect(readSiteLanguages(html)).toEqual({ declared: ["en"], detected: ["en"], stated: ["es"] });
});

test("a Montreal site with French and English alternates", () => {
  const head =
    '<link rel="alternate" hreflang="fr-CA" href="/fr"><link rel="alternate" hreflang="en-CA" href="/en"><link rel="alternate" hreflang="x-default" href="/">';
  const html = page("fr-CA", `<p>${TEXT.fr}</p><p>Nous parlons français et anglais.</p>`, head);
  expect(readSiteLanguages(html)).toEqual({
    declared: ["fr", "en"],
    detected: ["fr"],
    stated: ["fr"],
  });
  expect(readSiteLanguages(html.replace('lang="fr-CA"', 'lang="en-CA"')).declared).toEqual([
    "en",
    "fr",
  ]);
});

test("a Swiss site in German, French and Italian", () => {
  const head = ["de-CH", "fr-CH", "it-CH"]
    .map((l) => `<link rel="alternate" hreflang="${l}" href="/${l}">`)
    .join("");
  const html = page("de-CH", `<p>${TEXT.de}</p><p>${TEXT.fr}</p><p>${TEXT.it}</p>`, head);
  const languages = readSiteLanguages(html);
  expect(languages.declared).toEqual(["de", "fr", "it"]);
  expect([...languages.detected].sort()).toEqual(["de", "fr", "it"]);
});

test("a minor language under a fifth of the text is not detected", () => {
  const html = page("es", `${`<p>${TEXT.es}</p>`.repeat(5)}<p>${TEXT.en}</p>`);
  expect(readSiteLanguages(html).detected).toEqual(["es"]);
});

test("the text is read for what it is when the markup says otherwise", () => {
  expect(readSiteLanguages(page("en", `<p>${TEXT.es}</p>`))).toEqual({
    declared: ["en"],
    detected: ["es"],
    stated: [],
  });
});

test("scripts, styles and short fragments are not read as text", () => {
  const html = page(
    "es",
    `<script>var a = "${TEXT.en}";</script><style>.x{}</style><noscript>${TEXT.en}</noscript><p>Inicio</p><p>${TEXT.es}</p>`,
  );
  expect(readSiteLanguages(html).detected).toEqual(["es"]);
});

test("the meta and header Content-Language count as declared", () => {
  const html = `<html><head><meta http-equiv="Content-Language" content="pt-BR, it"></head><body></body></html>`;
  expect(readSiteLanguages(html, "de-DE").declared).toEqual(["pt", "it", "de"]);
});

test("languages outside the measurement languages and malformed tags are ignored", () => {
  const head =
    '<link rel="alternate" hreflang="ja" href="/ja"><link rel="alternate" hreflang="not a tag" href="/x">';
  expect(readSiteLanguages(page("zh-Hans", "<p>你好</p>", head), "ru")).toEqual({
    declared: [],
    detected: [],
    stated: [],
  });
});

test.each(["", "<<<>>>", "<html lang=", "plain text"])(
  "garbage HTML %j has no languages",
  (html) => {
    expect(readSiteLanguages(html)).toEqual({ declared: [], detected: [], stated: [] });
  },
);

test("a phrase inside a longer word is not a statement", () => {
  expect(readSiteLanguages("<p>Salon parle francaise</p>").stated).toEqual([]);
});

beforeAll(() => server.listen());
beforeEach(() => {
  dns.lookup.mockResolvedValue([{ address: "93.184.215.14", family: 4 }]);
});
afterEach(() => {
  server.resetHandlers();
  vi.clearAllMocks();
});
afterAll(() => server.close());

test("fetchSiteLanguages reads the page and its Content-Language header", async () => {
  server.use(
    http.get("https://dental.example/", () =>
      HttpResponse.html(page("en", `<p>${TEXT.en}</p>`), { headers: { "content-language": "es" } }),
    ),
  );
  expect(await fetchSiteLanguages("https://dental.example/", { timeoutMs: 2000 })).toEqual({
    declared: ["en", "es"],
    detected: ["en"],
    stated: [],
  });
});

test("fetchSiteLanguages is null for a page that is not a 200", async () => {
  server.use(http.get("https://dental.example/", () => new HttpResponse("gone", { status: 404 })));
  expect(await fetchSiteLanguages("https://dental.example/", { timeoutMs: 2000 })).toBeNull();
});
