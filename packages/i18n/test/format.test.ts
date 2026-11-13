import { describe, expect, test } from "vitest";
import {
  formatCost,
  formatDate,
  formatDateTime,
  formatMoney,
  formatNumber,
  formatPercent,
  formatPercentRange,
  getFormats,
  getTranslator,
} from "../src/index";

type Currency = "COP" | "USD" | "EUR";
const money = (amount_minor: number, currency: Currency) => ({ amount_minor, currency });
const cost = (amount_micros: number, currency: Currency) => ({ amount_micros, currency });
const es = { locale: "es-CO" } as const;
// ICU separates the symbol and the digits with a no-break space.
const nbsp = " ";

describe("formatMoney", () => {
  test("as published in Colombia", () => {
    expect(formatMoney(money(14_900_000, "COP"), es)).toBe(`$${nbsp}149.000`);
    expect(formatMoney(money(-14_900_000, "COP"), es)).toBe(`-$${nbsp}149.000`);
    expect(formatMoney(money(0, "COP"), es)).toBe(`$${nbsp}0`);
  });

  test("formats the exact decimal at the safe-integer limit", () => {
    // 90071992547409.91 must round up to ...410 and keep every digit in two-decimal currencies.
    expect(formatMoney(money(Number.MAX_SAFE_INTEGER, "COP"), es)).toBe(
      `$${nbsp}90.071.992.547.410`,
    );
    expect(formatMoney(money(Number.MAX_SAFE_INTEGER, "USD"), es)).toBe(
      `USD${nbsp}90.071.992.547.409,91`,
    );
    expect(formatMoney(money(-Number.MAX_SAFE_INTEGER, "USD"), es)).toBe(
      `-USD${nbsp}90.071.992.547.409,91`,
    );
  });

  test("keeps the cents of two-digit currencies", () => {
    expect(formatMoney(money(3_900, "USD"), es)).toBe(`USD${nbsp}39,00`);
    expect(formatMoney(money(5, "USD"), es)).toBe(`USD${nbsp}0,05`);
    expect(formatMoney(money(-5, "USD"), es)).toBe(`-USD${nbsp}0,05`);
    expect(formatMoney(money(4_550, "EUR"), es)).toBe(`EUR${nbsp}45,50`);
    expect(formatMoney(money(4_550, "EUR"), { ...es, viewerCountry: "ES" })).toBe(
      `EUR${nbsp}45,50`,
    );
  });

  test("shows the code when the visitor is outside the currency's country", () => {
    const cop = money(14_900_000, "COP");
    expect(formatMoney(cop, { ...es, viewerCountry: "MX" })).toBe(`COP${nbsp}149.000`);
    expect(formatMoney(cop, { ...es, viewerCountry: null })).toBe(`COP${nbsp}149.000`);
    expect(formatMoney(cop, { ...es, viewerCountry: "CU" })).toBe(`COP${nbsp}149.000`);
    expect(formatMoney(cop, { ...es, viewerCountry: "XX" })).toBe(`COP${nbsp}149.000`);
    expect(formatMoney(cop, { ...es, viewerCountry: "CO" })).toBe(`$${nbsp}149.000`);
    expect(formatMoney(money(3_900, "USD"), { ...es, viewerCountry: "CO" })).toBe(
      `USD${nbsp}39,00`,
    );
    expect(formatMoney(money(3_900, "USD"), { ...es, viewerCountry: "US" })).toBe(
      `US$${nbsp}39,00`,
    );
  });

  test("rejects amounts that are not safe integers", () => {
    expect(() => formatMoney(money(1.5, "COP"), es)).toThrow(RangeError);
    expect(() => formatMoney(money(Number.MAX_SAFE_INTEGER + 1, "COP"), es)).toThrow(RangeError);
  });
});

describe("viewerCountry normalization", () => {
  const cop = money(14_900_000, "COP");

  test("trims and uppercases the country before the lookup", () => {
    expect(formatMoney(cop, { ...es, viewerCountry: " co " })).toBe(`$${nbsp}149.000`);
    expect(formatMoney(cop, { ...es, viewerCountry: "co" })).toBe(`$${nbsp}149.000`);
    expect(formatMoney(cop, { ...es, viewerCountry: " mx" })).toBe(`COP${nbsp}149.000`);
  });
});

describe("formatCost", () => {
  test("keeps provider precision down to the micro-unit", () => {
    expect(formatCost(cost(1_200, "USD"), es)).toBe(`US$${nbsp}0,0012`);
    expect(formatCost(cost(1, "USD"), es)).toBe(`US$${nbsp}0,000001`);
    expect(formatCost(cost(600_000, "USD"), es)).toBe(`US$${nbsp}0,60`);
    expect(formatCost(cost(-4_000, "USD"), es)).toBe(`-US$${nbsp}0,004`);
  });

  test("zero cost", () => {
    expect(formatCost(cost(0, "USD"), es)).toBe(`US$${nbsp}0,00`);
  });

  test("rejects amounts that are not safe integers", () => {
    expect(() => formatCost(cost(0.5, "USD"), es)).toThrow(RangeError);
  });
});

describe("dates", () => {
  test("stay on the Bogotá day at 03:00 UTC", () => {
    expect(formatDate("2026-11-05T03:00:00Z", es)).toBe("4 de noviembre de 2026");
    expect(formatDate(new Date("2026-11-05T03:00:00Z"), es)).toBe("4 de noviembre de 2026");
    expect(formatDate("2026-11-05T05:00:00Z", es)).toBe("5 de noviembre de 2026");
  });

  test("accept another time zone", () => {
    expect(formatDate("2026-11-05T03:00:00Z", { ...es, timeZone: "Europe/Madrid" })).toBe(
      "5 de noviembre de 2026",
    );
  });

  test("date and time", () => {
    expect(formatDateTime("2026-11-05T03:00:00Z", es)).toBe(
      "4 de noviembre de 2026 a las 10:00 p. m.",
    );
  });

  test("reject invalid dates", () => {
    expect(() => formatDate("not a date", es)).toThrow(RangeError);
  });
});

describe("numbers and percentages", () => {
  test("formatNumber", () => {
    expect(formatNumber(1_234_567.891, es)).toBe("1.234.567,891");
    expect(formatNumber(-42, es)).toBe("-42");
  });

  test("a no-break space separates the figure and the percent sign", () => {
    expect(formatPercent(0, es)).toBe(`0${nbsp}%`);
    expect(formatPercent(0.2, es)).toBe(`20${nbsp}%`);
    expect(formatPercent(-0.05, es)).toBe(`-5${nbsp}%`);
    expect(formatPercent(1, es)).toBe(`100${nbsp}%`);
    expect(formatPercent(0.2054, { ...es, maximumFractionDigits: 1 })).toBe(`20,5${nbsp}%`);
    expect(formatPercent(12.5, es)).toBe(`1.250${nbsp}%`);
  });

  test("percent range", () => {
    expect(formatPercentRange(0.2, 0.45, es)).toBe(`entre 20${nbsp}% y 45${nbsp}%`);
    expect(formatPercentRange(0.2, 0.45, es).replaceAll(nbsp, " ")).toBe("entre 20 % y 45 %");
  });
});

describe("formatPercent input guard", () => {
  test.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
  ])("rejects %s with a TypeError", (_name, value) => {
    expect(() => formatPercent(value, es)).toThrow(TypeError);
    expect(() => formatPercent(value, es)).toThrow(/finite/);
  });
});

describe("translator formats", () => {
  test("getFormats exposes the country's money and date styles", () => {
    expect(getFormats("es-CO")).toEqual({
      number: {
        money: {
          style: "currency",
          currency: "COP",
          minimumFractionDigits: 0,
          maximumFractionDigits: 0,
        },
      },
      dateTime: {
        short: { day: "numeric", month: "short", year: "numeric" },
        long: { day: "numeric", month: "long", year: "numeric" },
      },
    });
  });

  test("the long date format renders as dateStyle long", () => {
    const { long } = getFormats("es-CO").dateTime;
    const date = new Date("2026-11-05T15:00:00Z");
    expect(new Intl.DateTimeFormat("es-CO", long).format(date)).toBe(
      new Intl.DateTimeFormat("es-CO", { dateStyle: "long" }).format(date),
    );
  });

  test("the money format matches formatMoney", () => {
    const { money: style } = getFormats("es-CO").number;
    expect(new Intl.NumberFormat("es-CO", style).format(149_000)).toBe(`$${nbsp}149.000`);
  });

  test("the translator formats dates in the country's time zone", () => {
    const t = getTranslator("es-CO", "legal");
    expect(t("lastUpdated", { date: new Date("2026-11-05T03:00:00Z") })).toBe(
      "Última actualización: 4 de noviembre de 2026",
    );
  });
});
