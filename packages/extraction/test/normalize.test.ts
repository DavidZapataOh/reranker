import { createHmac, randomBytes } from "node:crypto";
import type { EntityKind } from "@reranker/schema/measurement";
import { afterEach, describe, expect, test, vi } from "vitest";
import { jaroWinkler, nameHmac, normalizeName, tokenContainment } from "../src/normalize";

describe("normalizeName", () => {
  test.each([
    ["Clínica Dental Sonrisas S.A.S.", "business", "clinica dental sonrisas"],
    ["Dra. Ana Gómez", "professional", "ana gomez"],
    ["Dr Ana Gómez", "professional", "ana gomez"],
    ["  Hotel   La Ceiba LTDA ", "business", "hotel la ceiba"],
    ["IPS Salud Total E.U.", "business", "ips salud total"],
    ["Alimentos Ñame SAS", "business", "alimentos name"],
    ["Pinturas Tito S.A.", "business", "pinturas tito"],
    ["Café & Té: “La Esquina”!", "business", "cafe te la esquina"],
    ["rappi.com", "platform", "rappi com"],
  ])("normalizes %s", (raw, kind, expected) =>
    expect(normalizeName(raw, kind as EntityKind)).toBe(expected),
  );

  test("category words distinguish homonyms", () =>
    expect(normalizeName("Hotel La Ceiba")).not.toBe(normalizeName("La Ceiba Spa")));

  test("titles are only dropped for professionals", () =>
    expect(normalizeName("Dr. Muelas Clínica", "business")).toBe("dr muelas clinica"));

  test("a legal form alone is still a name", () => expect(normalizeName("S.A.S.")).toBe("sas"));

  test("decomposed and precomposed accents normalize alike", () =>
    expect(normalizeName("Gómez")).toBe(normalizeName("Gómez")));
});

describe("jaroWinkler", () => {
  test("reference values", () => {
    expect(jaroWinkler("martha", "marhta")).toBeCloseTo(0.9611, 4);
    expect(jaroWinkler("dixon", "dicksonx")).toBeCloseTo(0.8133, 4);
    expect(jaroWinkler("dwayne", "duane")).toBeCloseTo(0.84, 4);
    expect(jaroWinkler("", "")).toBe(1);
  });

  test("identical, disjoint and empty", () => {
    expect(jaroWinkler("sonrisas", "sonrisas")).toBe(1);
    expect(jaroWinkler("abc", "xyz")).toBe(0);
    expect(jaroWinkler("abc", "")).toBe(0);
  });

  test("is symmetric", () =>
    expect(jaroWinkler("cruz verde", "cruzverde")).toBe(jaroWinkler("cruzverde", "cruz verde")));
});

describe("tokenContainment", () => {
  test("is token based", () => {
    expect(tokenContainment("cruz verde", "drogueria cruz verde laureles")).toBe(true);
    expect(tokenContainment("drogueria cruz verde laureles", "cruz verde")).toBe(true);
    expect(tokenContainment("cruz", "cruzeiro")).toBe(false);
    expect(tokenContainment("cruz azul", "drogueria cruz verde")).toBe(false);
  });

  test("an empty name contains nothing", () => {
    expect(tokenContainment("", "cruz verde")).toBe(false);
    expect(tokenContainment("cruz verde", " ")).toBe(false);
  });
});

describe("nameHmac", () => {
  afterEach(() => vi.unstubAllEnvs());

  test("fails without the key, then signs with it", () => {
    vi.stubEnv("APP_ENV", "development");
    vi.stubEnv("ENTITY_NAME_HMAC_KEY", undefined);
    expect(() => nameHmac("ana gomez")).toThrow(/ENTITY_NAME_HMAC_KEY/);

    const key = randomBytes(32);
    vi.stubEnv("ENTITY_NAME_HMAC_KEY", key.toString("base64url"));
    const expected = createHmac("sha256", key).update("ana gomez").digest("hex");
    expect(nameHmac("ana gomez")).toBe(expected);
    expect(nameHmac("ana gomez")).toMatch(/^[0-9a-f]{64}$/);
    expect(nameHmac("ana gomes")).not.toBe(expected);
  });
});
