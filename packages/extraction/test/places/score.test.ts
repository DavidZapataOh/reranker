import type { EntityKind } from "@reranker/schema/measurement";
import { describe, expect, test } from "vitest";
import { currentExtractorConfig } from "../../src/config";
import { normalizeName } from "../../src/normalize";
import type { PlaceHit } from "../../src/places/client";
import { decide, type ScoredCandidate, scoreCandidates } from "../../src/places/score";

const cfg = currentExtractorConfig.resolution;
const noHint = { locationHint: null };

let nextId = 0;
const hit = (
  displayName: string,
  over: { types?: string[]; status?: string | null; address?: string | null } = {},
): PlaceHit => ({
  id: `place-${++nextId}`,
  displayName,
  formattedAddress: over.address === undefined ? "Calle 10 # 20-30, Medellín" : over.address,
  types: over.types ?? ["dental_clinic"],
  primaryType: over.types?.[0] ?? "dental_clinic",
  businessStatus: over.status === undefined ? "OPERATIONAL" : over.status,
});

const mention = (
  name: string,
  over: { kind?: EntityKind; locationHint?: string; citedDomains?: string[] } = {},
) => ({
  nameNorm: normalizeName(name, over.kind ?? "business"),
  kind: over.kind ?? "business",
  locationHint: over.locationHint ?? null,
  citedDomains: over.citedDomains ?? [],
});

const zero = { name: 0, tokens: 0, type: 0, location: 0, operational: 0, domain: 0 };

// A scored candidate whose name is unlike any other, so it never counts as a chain branch.
const s = (score: number, over: { cited?: boolean } = {}): ScoredCandidate => ({
  hit: hit(`Negocio ${++nextId}`),
  score,
  parts: { ...zero, name: 0.3 },
  awaitingWebsite: over.cited ?? false,
});

const branch = (name: string, score: number): ScoredCandidate => ({
  hit: hit(name),
  score,
  parts: { ...zero, name: cfg.weights.name },
  awaitingWebsite: false,
});

describe("scoreCandidates", () => {
  test("weights add to the spec values", () => {
    const [top] = scoreCandidates(
      mention("Clínica Sonrisas", { locationHint: "Laureles" }),
      [hit("Clínica Sonrisas", { address: "Cra. 76 # 33-10, Laureles, Medellín" })],
      { categoryTypes: ["dental_clinic"] },
      cfg,
    );
    expect(top?.score).toBeCloseTo(1, 5);
    expect(top?.parts).toEqual({
      name: 0.55,
      tokens: 0.15,
      type: 0.1,
      location: 0.1,
      operational: 0.1,
      domain: 0,
    });
  });

  test("each signal is earned only by its own evidence", () => {
    const [top] = scoreCandidates(
      mention("Clínica Sonrisas", { locationHint: "Laureles" }),
      [
        hit("Sonrisas Odontología Integral", {
          types: ["hospital"],
          status: "CLOSED_TEMPORARILY",
          address: null,
        }),
      ],
      { categoryTypes: ["dental_clinic"] },
      cfg,
    );
    expect(top?.parts).toMatchObject({ tokens: 0, type: 0, location: 0, operational: 0 });
    expect(top?.parts.name).toBeGreaterThan(0);
    expect(top?.parts.name).toBeLessThan(0.55);
  });

  test("the location hint must match whole address words", () => {
    const [top] = scoreCandidates(
      mention("Clínica Sonrisas", { locationHint: "Sur" }),
      [hit("Clínica Sonrisas", { address: "Surtidora 5, Medellín" })],
      { categoryTypes: [] },
      cfg,
    );
    expect(top?.parts.location).toBe(0);
  });

  test("candidates come back sorted by score, best first", () => {
    const scored = scoreCandidates(
      mention("Clínica Sonrisas"),
      [hit("Droguería Central"), hit("Clínica Sonrisas"), hit("Clínica Sonrisa Feliz")],
      { categoryTypes: ["dental_clinic"] },
      cfg,
    );
    expect(scored.map((c) => c.hit.displayName)).toEqual([
      "Clínica Sonrisas",
      "Clínica Sonrisa Feliz",
      "Droguería Central",
    ]);
  });

  test("cited domain equal to websiteUri adds 0.15, capped at 1", () => {
    const exact = hit("Clínica Sonrisas", { address: "Laureles, Medellín" });
    const other = hit("Clínica Sonrisas Norte");
    const [top, second] = scoreCandidates(
      mention("Clínica Sonrisas", {
        locationHint: "Laureles",
        citedDomains: ["clinicasonrisas.co"],
      }),
      [other, exact],
      {
        categoryTypes: ["dental_clinic"],
        websites: new Map([
          [exact.id, "https://www.ClinicaSonrisas.co/contacto"],
          [other.id, "https://sonrisasnorte.com/"],
        ]),
      },
      cfg,
    );
    expect(top?.hit.id).toBe(exact.id);
    expect(top?.parts.domain).toBe(0.15);
    expect(top?.score).toBe(1);
    expect(second?.parts.domain).toBe(0);
    expect(top?.awaitingWebsite).toBe(false);
  });

  test("a mention with cited URLs awaits websites until they are fetched", () => {
    const m = mention("Clínica Sonrisas", { citedDomains: ["clinicasonrisas.co"] });
    const [before] = scoreCandidates(m, [hit("Clínica Sonrisas")], { categoryTypes: [] }, cfg);
    const [after] = scoreCandidates(
      m,
      [hit("Clínica Sonrisas")],
      { categoryTypes: [], websites: new Map() },
      cfg,
    );
    expect(before?.awaitingWebsite).toBe(true);
    expect(after?.awaitingWebsite).toBe(false);
  });
});

describe("decide", () => {
  test("resolved needs top ≥ 0.90 and margin ≥ 0.08", () => {
    const top = s(0.93);
    expect(decide([top, s(0.8)], noHint, cfg)).toEqual({
      outcome: "place",
      placeId: top.hit.id,
      method: "rules",
      score: 0.93,
    });
    expect(decide([s(0.93)], noHint, cfg)).toMatchObject({ outcome: "place", method: "rules" });
    expect(decide([s(0.93), s(0.88)], noHint, cfg)).toMatchObject({ outcome: "needs_judge" });
  });

  test("gray zone goes to the judge with the top 3; below 0.60 is unresolvable", () => {
    const decision = decide([s(0.75), s(0.5), s(0.4), s(0.3)], noHint, cfg);
    expect(decision).toMatchObject({ outcome: "needs_judge" });
    expect(decision.outcome === "needs_judge" && decision.top3).toHaveLength(3);
    expect(decide([s(0.6)], noHint, cfg)).toMatchObject({ outcome: "needs_judge" });
    expect(decide([s(0.59)], noHint, cfg)).toEqual({
      outcome: "unresolvable",
      score: 0.59,
      method: "rules",
    });
  });

  test("several same-name branches without a location hint is a chain", () =>
    expect(
      decide(
        [branch("Cruz Verde", 0.95), branch("Cruz Verde", 0.95), branch("Cruz Verde", 0.94)],
        noHint,
        cfg,
      ),
    ).toEqual({ outcome: "chain", score: 0.95 }));

  test("the same branches with a location hint pick the matching one", () => {
    const m = mention("Cruz Verde", { locationHint: "Laureles" });
    const hits = [
      hit("Cruz Verde", { types: ["pharmacy"], address: "Cl. 50 # 40-20, Centro, Medellín" }),
      hit("Cruz Verde", { types: ["pharmacy"], address: "Cra. 70 # 1-10, Laureles, Medellín" }),
      hit("Cruz Verde", { types: ["pharmacy"], address: "Av. 80 # 30-5, Belén, Medellín" }),
    ];
    const scored = scoreCandidates(m, hits, { categoryTypes: ["pharmacy"] }, cfg);
    expect(decide(scored, m, cfg)).toMatchObject({
      outcome: "place",
      placeId: hits[1]?.id,
      method: "rules",
    });
  });

  test("a permanently closed site is not a branch of a chain", () => {
    const m = mention("Cruz Verde");
    const open = hit("Cruz Verde", { types: ["pharmacy"] });
    const scored = scoreCandidates(
      m,
      [hit("Cruz Verde", { types: ["pharmacy"], status: "CLOSED_PERMANENTLY" }), open],
      { categoryTypes: ["pharmacy"] },
      cfg,
    );
    expect(decide(scored, m, cfg)).toMatchObject({ outcome: "place", placeId: open.id });
  });

  test("close top two with cited URLs asks for websites first", () => {
    const top = s(0.91, { cited: true });
    const second = s(0.86, { cited: true });
    expect(decide([top, second, s(0.5, { cited: true })], noHint, cfg)).toEqual({
      outcome: "needs_website",
      top2: [top, second],
    });
  });

  test("once websites are known, close top two go to the judge", () =>
    expect(decide([s(0.91), s(0.86)], noHint, cfg)).toMatchObject({ outcome: "needs_judge" }));

  test("websites are skipped when even the domain bonus cannot reach the floor", () =>
    expect(decide([s(0.4, { cited: true }), s(0.38, { cited: true })], noHint, cfg)).toEqual({
      outcome: "unresolvable",
      score: 0.4,
      method: "rules",
    }));

  test("no hits is unresolvable with null score", () =>
    expect(decide([], noHint, cfg)).toEqual({
      outcome: "unresolvable",
      score: null,
      method: "rules",
    }));
});

describe("Places-style names", () => {
  const DISTRACTOR = "Clínica Dental Sonrisas";
  const DENTAL_CTX = { categoryTypes: ["dental_clinic"] };
  const decideFor = (m: ReturnType<typeof mention>, names: string[]) => {
    const hits = names.map((name) => hit(name));
    return { hits, decision: decide(scoreCandidates(m, hits, DENTAL_CTX, cfg), m, cfg) };
  };

  test.each([
    ["Dra. Ana Gómez", "Dra. Ana Gómez - Odontóloga"],
    ["Ana Gómez", "Dra. Ana Gómez"],
    ["Ana Gómez", "Odontóloga Ana Gómez"],
    ["Doctora Ana Gómez", "Dra. Ana Gómez | Ortodoncia y Estética Dental"],
    ["Dr. Juan Pérez", "Dr. Juan Pérez, Cirujano Plástico"],
    ["Juan Pérez", "Doctor Juan Pérez MD"],
  ])("the professional %s matches the listing %s by rules", (name, listing) => {
    const { hits, decision } = decideFor(mention(name, { kind: "professional" }), [
      listing,
      DISTRACTOR,
    ]);
    expect(decision).toMatchObject({ outcome: "place", placeId: hits[0]?.id, method: "rules" });
  });

  test("folding the listing without the mention's kind loses the match", () => {
    const m = mention("Dra. Ana Gómez", { kind: "professional" });
    const asBusiness = { ...m, kind: "business" as const };
    const hits = [hit("Dra. Ana Gómez - Odontóloga"), hit(DISTRACTOR)];
    expect(decide(scoreCandidates(asBusiness, hits, DENTAL_CTX, cfg), m, cfg)).toMatchObject({
      outcome: "needs_judge",
    });
  });

  test.each([
    ["another surname", "Dra. Ana Gómez Peña - Odontóloga"],
    ["a one-letter typo", "Dra. Ana Gámez"],
  ])("a professional listing with %s still goes to the judge", (_, listing) =>
    expect(
      decideFor(mention("Dra. Ana Gómez", { kind: "professional" }), [listing, DISTRACTOR])
        .decision,
    ).toMatchObject({ outcome: "needs_judge" }),
  );

  test.each([
    ["Clínica Dental Sonrisas", "Clínica Dental Sonrisas S. A. S."],
    ["Ferretería Pérez", "Ferretería Pérez & Cía. Ltda."],
    ["Farmacias del Ahorro", "Farmacias del Ahorro S.A. de C.V."],
  ])("the business %s matches the listing %s by rules", (name, listing) => {
    const { hits, decision } = decideFor(mention(name), [listing, "Dra. Ana Gómez"]);
    expect(decision).toMatchObject({ outcome: "place", placeId: hits[0]?.id, method: "rules" });
  });

  test("a business listing with another name and a legal form still goes to the judge", () =>
    expect(
      decideFor(mention("Clínica Dental Sonrisas"), [
        "Clínica Dental Sonrisa Feliz S.A.S.",
        "Dra. Ana Gómez",
      ]).decision,
    ).toMatchObject({ outcome: "needs_judge" }));

  test("branches listed with and without a legal form are one chain", () =>
    expect(
      decideFor(mention("Cruz Verde", { kind: "chain" }), [
        "Cruz Verde",
        "CRUZ VERDE S. A. S.",
        "Droguería Cruz Verde",
      ]).decision,
    ).toMatchObject({ outcome: "chain" }));
});
