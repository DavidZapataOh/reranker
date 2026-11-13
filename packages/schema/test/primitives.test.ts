import { describe, expect, test } from "vitest";
import { DateOnly, Email, Page, PageQuery, Timestamp, Url, Uuid } from "../src/primitives";

describe("primitives", () => {
  test("Email normalizes and validates", () => {
    expect(Email.parse("  Ana@Negocio.CO ")).toBe("ana@negocio.co");
    expect(Email.safeParse("ana@").success).toBe(false);
  });

  test("Url accepts only http(s)", () => {
    expect(Url.safeParse("https://reranker.co").success).toBe(true);
    for (const bad of ["javascript:alert(1)", "ftp://x.co", "data:text/html,x", "https://"]) {
      expect(Url.safeParse(bad).success).toBe(false);
    }
  });

  test("Timestamp requires UTC Z", () => {
    expect(Timestamp.safeParse("2026-11-05T03:00:00Z").success).toBe(true);
    expect(Timestamp.safeParse("2026-11-05T03:00:00-05:00").success).toBe(false);
  });

  test("DateOnly accepts calendar dates only", () => {
    expect(DateOnly.safeParse("2026-11-05").success).toBe(true);
    expect(DateOnly.safeParse("2026-11-05T00:00:00Z").success).toBe(false);
  });

  test("PageQuery defaults and bounds", () => {
    expect(PageQuery.parse({})).toEqual({ limit: 20 });
    expect(PageQuery.parse({ limit: "100" }).limit).toBe(100);
    expect(PageQuery.safeParse({ limit: "0" }).success).toBe(false);
    expect(PageQuery.safeParse({ limit: "101" }).success).toBe(false);
    expect(PageQuery.safeParse({ cursor: "a b" }).success).toBe(false);
  });

  test("Page shape", () => {
    expect(Page(Uuid).parse({ data: [], next_cursor: null })).toEqual({
      data: [],
      next_cursor: null,
    });
  });
});
