import { readFileSync } from "node:fs";
import { parse } from "csv-parse/sync";
import { describe, expect, test } from "vitest";
import {
  buildCountry,
  CSV_OPTIONS,
  type DivipolaRecord,
  type LocationRow,
  officialName,
} from "../scripts/build-geo.ts";
import { expandGeoFile, type GeoPlace } from "../src/geo/format.ts";
import { normalizePlaceName } from "../src/geo/normalize.ts";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/geo/${name}`, import.meta.url), "utf8");
const rows = (name: string): LocationRow[] => parse(fixture(name), CSV_OPTIONS);

const csvMx = rows("locations-mx-jalisco.csv");
const csvCo = rows("locations-co.csv");
const divipola: DivipolaRecord[] = JSON.parse(fixture("divipola-extract.json"));
const co = expandGeoFile(buildCountry(csvCo, { divipola }));

const findByName = (places: readonly GeoPlace[], normalized: string) =>
  places.find((p) => p.level === "city" && p.normalized === normalized);
const byDivipola = (places: readonly GeoPlace[], code: string) => {
  const place = places.find((p) => p.divipola?.municipalityCode === code);
  if (!place) throw new Error(`no place for DIVIPOLA ${code}`);
  return place;
};

describe("buildCountry with DIVIPOLA", () => {
  test("Medellín resolves to its city code", () =>
    expect(byDivipola(co, "05001")).toMatchObject({
      key: "co-c1003654",
      level: "city",
      name: "Medellín",
      locationCode: 1003654,
      regionKey: "co-r20198",
      divipola: { municipalityCode: "05001", departmentCode: "05" },
    }));

  test("Envigado keeps the Municipio,Departamento form among duplicates", () =>
    expect(byDivipola(co, "05266").locationCode).toBe(1003652));

  test("Salento falls back to Quindío with level region", () =>
    expect(byDivipola(co, "63690")).toMatchObject({
      key: "co-c63690",
      level: "region",
      name: "Salento",
      locationCode: 21519,
      regionKey: "co-r21519",
    }));

  test("Bogotá D.C. is a city with code 1003659", () =>
    expect(byDivipola(co, "11001")).toMatchObject({
      level: "city",
      locationCode: 1003659,
      normalized: "bogota",
    }));

  test("homonymous municipalities resolve within their own department", () => {
    expect(byDivipola(co, "05079").locationCode).toBe(1029276);
    expect(byDivipola(co, "68077").locationCode).toBe(1029275);
  });

  test("a city listed under a shorter name keeps the official accents", () =>
    expect(byDivipola(co, "05148")).toMatchObject({
      level: "city",
      name: "Carmen de Viboral",
      locationCode: 1029285,
    }));

  test("every municipality carries its DIVIPOLA centroid", () => {
    expect(byDivipola(co, "05001").center).toEqual([6.246631, -75.581775]);
    expect(co.filter((p) => p.divipola).every((p) => p.center !== null)).toBe(true);
  });

  test("one place per municipality and never a neighborhood", () => {
    expect(co.filter((p) => p.divipola)).toHaveLength(divipola.length);
    expect(co.filter((p) => p.divipola === undefined && p.level === "city")).toEqual([]);
  });

  test("departments are named as DIVIPOLA names them", () =>
    expect(co.find((p) => p.key === "co-r20203")).toMatchObject({
      level: "region",
      name: "Bogotá, D.C.",
      regionKey: null,
    }));

  test("the output is deterministic", () =>
    expect(buildCountry([...csvCo].reverse(), { divipola: [...divipola].reverse() })).toEqual(
      buildCountry(csvCo, { divipola }),
    ));
});

describe("officialName", () => {
  test.each([
    ["BOGOTÁ, D.C.", "Bogotá, D.C."],
    ["EL CARMEN DE VIBORAL", "El Carmen de Viboral"],
    ["BELÉN DE LOS ANDAQUÍES", "Belén de los Andaquíes"],
    ["CASTILLA LA NUEVA", "Castilla La Nueva"],
    ["PIENDAMÓ - TUNÍA", "Piendamó - Tunía"],
    [
      "ARCHIPIÉLAGO DE SAN ANDRÉS, PROVIDENCIA Y SANTA CATALINA",
      "Archipiélago de San Andrés, Providencia y Santa Catalina",
    ],
  ])("%s reads as %s", (upper, prose) => expect(officialName(upper)).toBe(prose));
});

describe("buildCountry", () => {
  test("a Mexican city gets its state as region", () =>
    expect(findByName(expandGeoFile(buildCountry(csvMx)), "guadalajara")).toMatchObject({
      level: "city",
      regionKey: expect.stringMatching(/^mx-r/),
    }));

  test("duplicate cities in one region keep the shortest form", () => {
    const guadalajara = expandGeoFile(buildCountry(csvMx)).filter(
      (p) => p.normalized === "guadalajara",
    );
    expect(guadalajara.map((p) => p.locationCode)).toEqual([9047210]);
  });

  test("the output is deterministic", () =>
    expect(buildCountry([...csvMx].reverse())).toEqual(buildCountry(csvMx)));

  test("rows from several countries are rejected", () =>
    expect(() =>
      buildCountry([...csvMx, ...csvMx.map((row) => ({ ...row, country_iso_code: "GT" }))]),
    ).toThrow(/one country/));
});

describe("expandGeoFile", () => {
  const regions: [number, string][] = [[21519, "Quindío"]];

  test("cities without a region keep a null region key", () =>
    expect(
      expandGeoFile({ country: "WS", regions: [], cities: [[1000001, "Apia", null]] }),
    ).toMatchObject([{ key: "ws-c1000001", level: "city", regionKey: null, center: null }]));

  test("a municipality without its own code is declared as its region", () =>
    expect(
      expandGeoFile({
        country: "CO",
        regions,
        cities: [[null, "Salento", 0, [4.637157, -75.570844], "63690"]],
      }),
    ).toContainEqual({
      key: "co-c63690",
      level: "region",
      name: "Salento",
      normalized: "salento",
      regionKey: "co-r21519",
      locationCode: 21519,
      center: [4.637157, -75.570844],
      divipola: { municipalityCode: "63690", departmentCode: "63" },
    }));

  test("a row pointing at a missing region is rejected", () =>
    expect(() => expandGeoFile({ country: "MX", regions, cities: [[1, "X", 3]] })).toThrow(
      RangeError,
    ));

  test("a municipality without its own code needs a region to borrow one from", () =>
    expect(() =>
      expandGeoFile({
        country: "CO",
        regions,
        cities: [[null, "Salento", null, [4.6, -75.6], "63690"]],
      }),
    ).toThrow(RangeError));
});

describe("normalizePlaceName", () => {
  test("normalizes names", () => expect(normalizePlaceName("  Bogotá, D.C. ")).toBe("bogota"));
  test("folds case, accents and punctuation", () =>
    expect(normalizePlaceName("PIENDAMÓ - TUNÍA")).toBe("piendamo tunia"));
  test("keeps letters outside Latin", () => expect(normalizePlaceName("Łódź")).toBe("łodz"));
});
