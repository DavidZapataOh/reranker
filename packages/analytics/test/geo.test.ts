import { expect, test } from "vitest";
import { countryFromGeoKey } from "../src/geo";

test("reads the country prefix of a geo key", () => {
  expect(countryFromGeoKey("mx-c4120")).toBe("MX");
  expect(countryFromGeoKey("co")).toBe("CO");
});

test("returns null for unknown countries and empty keys", () => {
  expect(countryFromGeoKey("zz-r1")).toBeNull();
  expect(countryFromGeoKey("")).toBeNull();
});
