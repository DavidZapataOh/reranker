import { cost } from "@reranker/schema";
import { describe, expect, test } from "vitest";
import { spendCapsCheck } from "./caps";

const usd = (amount: number) => cost(amount * 1_000_000, "USD");

const sized = {
  caps: {
    "purpose:free-report": usd(200),
    "provider:dataforseo": usd(379.8),
    "provider:anthropic": usd(48.6),
  },
  floors: { dataforseo: 379_800_000, anthropic: 48_600_000 },
};

describe("spendCapsCheck", () => {
  test("caps sized by demand pass", () => {
    expect(spendCapsCheck(sized)).toMatchObject({ id: "spend-caps", status: "pass" });
  });

  test("launch check fails when a provider cap could starve a purpose", () => {
    const result = spendCapsCheck({
      ...sized,
      caps: { ...sized.caps, "provider:dataforseo": usd(10) },
    });
    expect(result.status).toBe("fail");
    expect(result.reason).toContain("dataforseo");
  });

  test("a free report cap below US$200 fails", () => {
    const result = spendCapsCheck({
      ...sized,
      caps: { ...sized.caps, "purpose:free-report": usd(50) },
    });
    expect(result.status).toBe("fail");
    expect(result.reason).toContain("reporte gratis");
  });

  test("a provider without a cap fails like a cap of zero", () => {
    const result = spendCapsCheck({ ...sized, floors: { ...sized.floors, xai: 48_600_000 } });
    expect(result).toMatchObject({ status: "fail", reason: expect.stringContaining("xai") });
  });
});
