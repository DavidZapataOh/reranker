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
    expect(platformFor({ nameNorm: normalizeName(name), citedUrls: [] })?.kind).toBe("platform"),
  );

  test.each(["Rappi", "rappi.com", "DiDi Food", "Facebook", "TikTok", "YouTube", "Waze"])(
    "%s is a directory or medium",
    (name) =>
      expect(platformFor({ nameNorm: normalizeName(name), citedUrls: [] })?.kind).toBe(
        "directory_or_media",
      ),
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
      for (const alias of [...entry.names, ...entry.domains].map((a) => normalizeName(a))) {
        expect(owners.get(alias) ?? entry.slug).toBe(entry.slug);
        owners.set(alias, entry.slug);
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
