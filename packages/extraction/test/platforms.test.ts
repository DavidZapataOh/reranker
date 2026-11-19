import type { ExtractedMention } from "@reranker/schema/measurement";
import { describe, expect, test } from "vitest";
import { normalizeName } from "../src/normalize";
import { PLATFORMS, platformFor, tagPlatforms } from "../src/platforms";

let offset = 0;
const mention = (over: Partial<ExtractedMention> & { name: string }): ExtractedMention => {
  const startOffset = offset;
  offset += 100;
  const entityKind = over.entityKind ?? "business";
  return {
    nameNorm: normalizeName(over.name, entityKind),
    quote: over.name,
    startOffset,
    endOffset: startOffset + over.name.length,
    ordinal: null,
    stance: "recommendation",
    entityKind,
    sentiment: "positive",
    locationHint: null,
    citedUrls: [],
    ...over,
  };
};

describe("platformFor", () => {
  test.each([
    "Booking.com",
    "booking",
    "Airbnb",
    "Doctoralia",
    "Finca Raíz",
    "Metro Cuadrado",
    "Google Maps",
  ])("%s is a platform", (name) =>
    expect(platformFor({ nameNorm: normalizeName(name, "platform"), citedUrls: [] })?.kind).toBe(
      "platform",
    ),
  );

  test.each(["Rappi", "rappi.com", "DiDi Food", "Facebook", "TikTok", "YouTube", "Waze"])(
    "%s is a directory or medium",
    (name) =>
      expect(
        platformFor({ nameNorm: normalizeName(name, "directory_or_media"), citedUrls: [] })?.kind,
      ).toBe("directory_or_media"),
  );

  test("cited domain identifies the platform even with an odd name", () =>
    expect(
      platformFor({
        nameNorm: "la app de reservas",
        citedUrls: ["https://www.booking.com/hotel/co/x.html"],
      })?.slug,
    ).toBe("booking"));

  test("a country domain of the platform counts", () =>
    expect(
      platformFor({ nameNorm: "x", citedUrls: ["https://www.doctoralia.com.mx/ana-gomez"] })?.slug,
    ).toBe("doctoralia"));

  test("a business named after a word in a platform name is not a platform", () =>
    expect(platformFor({ nameNorm: "hotel booking plaza", citedUrls: [] })).toBeNull());

  test.each([
    "https://notbooking.com/",
    "https://booking.com.evil.co/",
    "https://www.google.com/search?q=maps",
    "https://www.google.com/mapsy",
    "no es una url",
  ])("%s does not identify a platform", (url) =>
    expect(platformFor({ nameNorm: "x", citedUrls: [url] })).toBeNull(),
  );

  test("a path-scoped domain matches only under its path", () =>
    expect(
      platformFor({ nameNorm: "x", citedUrls: ["https://www.google.com/maps/place/Sonrisas"] })
        ?.slug,
    ).toBe("google-maps"));

  test("every alias and domain belongs to exactly one platform", () => {
    const owners = new Map<string, string>();
    for (const entry of PLATFORMS) {
      for (const alias of [...entry.names, ...entry.domains].map((a) =>
        normalizeName(a, entry.kind),
      )) {
        expect(owners.get(alias) ?? entry.slug).toBe(entry.slug);
        owners.set(alias, entry.slug);
      }
    }
  });
});

describe("platforms by market", () => {
  test.each([
    ["ES", "Idealista", "idealista"],
    ["ES", "Fotocasa", "fotocasa"],
    ["ES", "Habitaclia", "habitaclia"],
    ["ES", "pisos.com", "pisos-com"],
    ["ES", "Glovo", "glovo"],
    ["ES", "Just Eat", "just-eat"],
    ["ES", "ElTenedor", "thefork"],
    ["ES", "Top Doctors", "top-doctors"],
    ["ES", "Habitissimo", "habitissimo"],
    ["ES", "Treatwell", "treatwell"],
    ["ES", "Guía Repsol", "guia-repsol"],
    ["ES", "Páginas Amarillas", "paginas-amarillas"],
    ["ES", "Wallapop", "wallapop"],
    ["ES", "Coches.net", "coches-net"],
    ["ES", "Emagister", "emagister"],
    ["MX", "Inmuebles24", "inmuebles24"],
    ["MX", "Vivanuncios", "vivanuncios"],
    ["MX", "Lamudi", "lamudi"],
    ["MX", "Uber Eats", "uber-eats"],
    ["MX", "Sección Amarilla", "seccion-amarilla"],
    ["MX", "Doctor Anytime", "doctoranytime"],
    ["MX", "Cronoshare", "cronoshare"],
    ["AR", "Zonaprop", "zonaprop"],
    ["AR", "Argenprop", "argenprop"],
    ["AR", "PedidosYa", "pedidosya"],
    ["AR", "Mercado Libre", "mercadolibre"],
    ["AR", "Zolvers", "zolvers"],
    ["AR", "Despegar", "despegar"],
    ["CL", "Portal Inmobiliario", "portal-inmobiliario"],
    ["CL", "Yapo", "yapo"],
    ["CL", "TocToc", "toctoc"],
    ["CL", "AgendaPro", "agendapro"],
    ["CL", "Chileautos", "chileautos"],
    ["PE", "Urbania.pe", "urbania"],
    ["PE", "Adondevivir", "adondevivir"],
    ["PE", "Neoauto", "neoauto"],
    ["PE", "Lawzana", "lawzana"],
    ["EC", "Plusvalia.com", "plusvalia"],
    ["EC", "Patiotuerca", "patiotuerca"],
    ["EC", "Properati", "properati"],
    ["UY", "InfoCasas", "infocasas"],
    ["UY", "Gallito.com.uy", "gallito"],
    ["US", "Zillow", "zillow"],
    ["US", "Realtor.com", "realtor-com"],
    ["US", "Yelp", "yelp"],
    ["US", "Zocdoc", "zocdoc"],
    ["US", "Angi", "angi"],
    ["US", "Thumbtack", "thumbtack"],
    ["US", "DoorDash", "doordash"],
    ["US", "Avvo", "avvo"],
    ["US", "OpenTable", "opentable"],
    ["US", "Better Business Bureau", "bbb"],
    ["GB", "Rightmove", "rightmove"],
    ["GB", "Checkatrade", "checkatrade"],
    ["FR", "Doctolib", "doctolib"],
    ["FR", "SeLoger", "seloger"],
    ["DE", "Lieferando", "lieferando"],
    ["IT", "MioDottore", "miodottore"],
    ["BR", "iFood", "ifood"],
    ["BR", "Mercado Livre", "mercadolibre"],
  ])("%s: %s is %s", (_market, name, slug) =>
    expect(platformFor({ nameNorm: normalizeName(name, "platform"), citedUrls: [] })?.slug).toBe(
      slug,
    ),
  );

  test.each([
    ["ES", "https://www.idealista.com/inmueble/1/", "idealista"],
    ["ES", "https://www.thefork.es/restaurante/x-r1", "thefork"],
    ["MX", "https://web.didiglobal.com/mx/food/ciudad-de-mexico-cdmx/", "didi-food"],
    ["MX", "https://inmuebles.mercadolibre.com.mx/departamentos/", "mercadolibre"],
    ["MX", "https://www.doctoralia.com.mx/ana-gomez", "doctoralia"],
    ["AR", "https://www.doctoraliar.com/odontologo/capital-federal", "doctoralia"],
    ["AR", "https://www.pedidosya.com.ar/restaurantes/buenos-aires", "pedidosya"],
    ["CL", "https://www.trivago.cl/es-CL/srl/hoteles-santiago", "trivago"],
    ["PE", "https://nexoinmobiliario.pe/proyectos", "nexo-inmobiliario"],
    ["PE", "https://www.doctoralia.pe/dentista/lima", "doctoralia"],
    ["EC", "https://www.kayak.com.ec/hoteles", "kayak"],
    ["UY", "https://www.gallito.com.uy/inmuebles", "gallito"],
    ["UY", "https://ar.hoteles.com/nh1705099/", "hotels-com"],
    ["US", "https://maps.apple.com/?q=x", "apple-maps"],
    ["GB", "https://www.just-eat.co.uk/area/ec1", "just-eat"],
  ])("%s: %s is %s", (_market, url, slug) =>
    expect(platformFor({ nameNorm: "x", citedUrls: [url] })?.slug).toBe(slug),
  );

  test.each(["Uber Eats", "PedidosYa", "Glovo", "Deliveroo", "DoorDash", "iFood"])(
    "%s, a delivery app, is a directory like Rappi",
    (name) =>
      expect(
        platformFor({ nameNorm: normalizeName(name, "directory_or_media"), citedUrls: [] })?.kind,
      ).toBe("directory_or_media"),
  );

  test.each([
    "Realtor",
    "Plusvalía",
    "Pisos",
    "Propiedades",
    "Urbania",
    "Gallito",
    "La Haus",
    "Nexo Inmobiliario",
    "Toc Toc",
    "El Tenedor",
    "The Fork",
    "Repsol",
    "Michelin",
    "Seamless",
    "Expertise",
    "Chambers",
    "Martindale",
    "Abogado",
    "Yell",
    "Next Door",
    "Coches",
    "Immobiliare",
    "Seminuevos",
    "Hoteles",
    "X",
  ])("%s, a common word or business name, is not a platform", (name) =>
    expect(platformFor({ nameNorm: normalizeName(name, "business"), citedUrls: [] })).toBeNull(),
  );

  test("a restaurant called El Tenedor stays a business", () =>
    expect(tagPlatforms([mention({ name: "El Tenedor" })])[0]?.entityKind).toBe("business"));

  test("no alias is a single character", () => {
    for (const entry of PLATFORMS) {
      for (const alias of [...entry.names, ...entry.domains]) {
        expect(normalizeName(alias, entry.kind).replace(/ /g, "").length).toBeGreaterThan(1);
      }
    }
  });
});

describe("tagPlatforms", () => {
  test("tagging overrides what the LLM said", () =>
    expect(
      tagPlatforms([mention({ name: "Booking", entityKind: "business" })])[0]?.entityKind,
    ).toBe("platform"));

  test("a business cited through its listing on a platform stays a business", () =>
    expect(
      tagPlatforms([
        mention({
          name: "Hotel La Ceiba",
          citedUrls: ["https://www.booking.com/hotel/co/la-ceiba.html"],
        }),
      ])[0]?.entityKind,
    ).toBe("business"));

  test("a mention the model left unclassified is tagged by its cited domain", () =>
    expect(
      tagPlatforms([
        mention({
          name: "la app de reservas",
          entityKind: "other",
          citedUrls: ["https://www.airbnb.com.co/rooms/1"],
        }),
      ])[0]?.entityKind,
    ).toBe("platform"));

  test("a platform loses its rank and the businesses after it move up", () => {
    const tagged = tagPlatforms([
      { ...mention({ name: "Booking" }), ordinal: 1 },
      { ...mention({ name: "Hotel A" }), ordinal: 2 },
      { ...mention({ name: "Hotel B" }), ordinal: 3 },
    ]);
    expect(tagged.map((m) => [m.name, m.entityKind, m.ordinal])).toEqual([
      ["Booking", "platform", null],
      ["Hotel A", "business", 1],
      ["Hotel B", "business", 2],
    ]);
  });

  test("does not mutate its input", () => {
    const input = [mention({ name: "Airbnb" })];
    tagPlatforms(input);
    expect(input[0]?.entityKind).toBe("business");
  });
});
