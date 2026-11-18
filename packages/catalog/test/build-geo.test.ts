import { readFileSync } from "node:fs";
import { parse } from "csv-parse/sync";
import { describe, expect, test } from "vitest";
import { buildCountry, CSV_OPTIONS, type LocationRow } from "../scripts/build-geo.ts";
import { expandGeoFile, type GeoPlace } from "../src/geo/format.ts";
import { normalizePlaceName } from "../src/geo/normalize.ts";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/geo/${name}`, import.meta.url), "utf8");
const rows = (name: string): LocationRow[] => parse(fixture(name), CSV_OPTIONS);

const csvMx = rows("locations-mx-jalisco.csv");

const findByName = (places: readonly GeoPlace[], normalized: string) =>
  places.find((p) => p.level === "city" && p.normalized === normalized);

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
