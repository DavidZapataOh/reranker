import { describe, expect, test } from "vitest";
import { currencyForCountry, formatPrice, PRICES } from "./pricing";

describe("currencyForCountry", () => {
  test("Colombia pays in pesos", () => {
    expect(currencyForCountry("CO")).toBe("cop");
    expect(currencyForCountry("co")).toBe("cop");
  });

  test.each(["ES", "FR", "DE", "IT", "PT", "IE", "BG", "HR", "AD", "MC", "ME"])(
    "%s pays in euros",
    (country) => {
      expect(currencyForCountry(country)).toBe("eur");
    },
  );

  test.each(["MX", "AR", "CL", "PE", "US", "GB", "CH", "SE", "BR"])(
    "%s pays in dollars",
    (country) => {
      expect(currencyForCountry(country)).toBe("usd");
    },
  );

  test.each([null, undefined, "", "  "])("unknown country %j defaults to dollars", (country) => {
    expect(currencyForCountry(country)).toBe("usd");
  });
});

describe("formatPrice", () => {
  test("always shows an unambiguous currency", () => {
    expect(formatPrice("cop", PRICES.cop.essential)).toBe("COP 149.000");
    expect(formatPrice("cop", PRICES.cop.pro)).toBe("COP 299.000");
    expect(formatPrice("eur", PRICES.eur.essential)).toBe("€45");
    expect(formatPrice("usd", PRICES.usd.essential)).toBe("US$39");
    expect(formatPrice("usd", 0)).toBe("US$0");
  });
});
