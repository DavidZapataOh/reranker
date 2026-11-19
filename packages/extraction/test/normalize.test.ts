import { createHmac, randomBytes } from "node:crypto";
import type { EntityKind } from "@reranker/schema/measurement";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  jaroWinkler,
  nameHmac,
  normalizeName,
  normalizeText,
  tokenContainment,
} from "../src/normalize";

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
    // Spellings Places listings use for legal forms.
    ["Clínica Sonrisas S. A. S.", "business", "clinica sonrisas"],
    ["Inversiones Gómez S.A.S", "business", "inversiones gomez"],
    ["Ferretería Pérez & Cía. Ltda.", "business", "ferreteria perez"],
    ["Ferretería Pérez y Cía", "business", "ferreteria perez"],
    ["Farmacias del Ahorro S.A. de C.V.", "business", "farmacias del ahorro"],
    ["Taller Ruiz S. de R.L. de C.V.", "business", "taller ruiz"],
    ["Constructora Andina S.A.C.", "business", "constructora andina"],
    ["Café Lima E.I.R.L.", "business", "cafe lima"],
    ["Hotel Sol S.L.", "business", "hotel sol"],
    ["Joe's Pizza LLC", "business", "joe s pizza"],
    // Spellings Places listings use for professionals.
    ["Doctora Ana Gómez", "professional", "ana gomez"],
    ["Odontóloga Ana Gómez", "professional", "ana gomez"],
    ["Dra. Ana Gómez - Odontóloga", "professional", "ana gomez"],
    ["Dra. Ana Gómez | Ortodoncia y Estética Dental", "professional", "ana gomez"],
    ["Dr. Juan Pérez, Cirujano Plástico", "professional", "juan perez"],
    ["Dr. Juan Pérez (Ortopedista)", "professional", "juan perez"],
    ["Juan Pérez MD", "professional", "juan perez"],
    ["Ana Gómez-Restrepo", "professional", "ana gomez restrepo"],
    ["J. P. Restrepo", "professional", "jp restrepo"],
  ])("normalizes %s", (raw, kind, expected) =>
    expect(normalizeName(raw, kind as EntityKind)).toBe(expected),
  );

  test("category words distinguish homonyms", () =>
    expect(normalizeName("Hotel La Ceiba", "business")).not.toBe(
      normalizeName("La Ceiba Spa", "business"),
    ));

  test("titles are only dropped for professionals", () => {
    expect(normalizeName("Dr. Muelas Clínica", "business")).toBe("dr muelas clinica");
    expect(normalizeName("Doctor Simi", "chain")).toBe("doctor simi");
  });

  test("separators only cut descriptors from professionals' names", () =>
    expect(normalizeName("Café - Bar La Esquina", "business")).toBe("cafe bar la esquina"));

  test("a title or legal form alone is still a name", () => {
    expect(normalizeName("S.A.S.", "business")).toBe("sas");
    expect(normalizeName("Dra.", "professional")).toBe("dra");
    expect(normalizeName("Odontóloga - Ana Gómez", "professional")).toBe("ana gomez");
  });

  test("decomposed and precomposed accents normalize alike", () =>
    expect(normalizeName("Gómez", "business")).toBe(normalizeName("Gómez", "business")));
});

describe("normalizeText", () => {
  test("folds addresses without dropping what a name would", () =>
    expect(normalizeText("Dr. Simi, Sabaneta S.A.")).toBe("dr simi sabaneta sa"));
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
