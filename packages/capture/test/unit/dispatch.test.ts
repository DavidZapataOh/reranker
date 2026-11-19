import type { EngineId } from "@reranker/schema";
import { describe, expect, test } from "vitest";
import { dispatchOrder, retryFits } from "../../src/dispatch";
import { type FrozenSlot, slotId } from "../../src/slot";

const MEASUREMENT = "0193b6f2-7c1e-7a51-9b3a-5f2e8d4c1a90";

function slot(slotIndex: number, engine: EngineId, intent: string): FrozenSlot {
  return {
    engine,
    provider: "dataforseo",
    intentSetId: "is_0123456789abcdef",
    intentId: `dental_clinic.${intent}` as FrozenSlot["intentId"],
    paraphraseId: "p1",
    geoKey: "co-c1003654",
    geoDeclared: { level: "city", label: "Medellín" },
    runIndex: 0,
    promptText: "¿Cuál es el mejor odontólogo en Medellín?",
    measurementId: MEASUREMENT,
    slotIndex,
    slotId: slotId(MEASUREMENT, slotIndex),
  };
}

describe("dispatchOrder", () => {
  test("slowest engines go first and intents take turns within each engine", () => {
    const slots = [
      slot(0, "google-ai-mode", "best"),
      slot(1, "google-ai-overview", "best"),
      slot(2, "gemini", "best"),
      slot(3, "gemini", "best"),
      slot(4, "gemini", "cheap"),
      slot(5, "google-ai-overview", "cheap"),
      slot(6, "gemini", "open-now"),
    ];
    expect(dispatchOrder(slots).map((s) => [s.engine, s.slotIndex])).toEqual([
      ["gemini", 2],
      ["gemini", 4],
      ["gemini", 6],
      ["gemini", 3],
      ["google-ai-overview", 1],
      ["google-ai-overview", 5],
      ["google-ai-mode", 0],
    ]);
  });

  test("no slot is lost or repeated", () => {
    const engines: EngineId[] = ["gemini", "google-ai-mode", "chatgpt"];
    const slots = Array.from({ length: 30 }, (_, i) =>
      slot(i, engines[i % 3] as EngineId, `i${i % 4}`),
    );
    const ordered = dispatchOrder(slots);
    expect(ordered.map((s) => s.slotIndex).sort((a, b) => a - b)).toEqual(slots.map((_, i) => i));
  });

  test("an empty plan dispatches nothing", () => expect(dispatchOrder([])).toEqual([]));
});

describe("retryFits", () => {
  const gemini = slot(0, "gemini", "best");
  const now = 1_000_000;

  test("a retry runs when the wait and the engine's p50 end before the deadline", () => {
    expect(retryFits({ slot: gemini, retryAfterMs: 5000, deadlineAt: now + 32_001, now })).toBe(
      true,
    );
  });

  test("no retry when the wait and the engine's p50 reach past the deadline", () => {
    expect(retryFits({ slot: gemini, retryAfterMs: 5000, deadlineAt: now + 32_000, now })).toBe(
      false,
    );
    expect(retryFits({ slot: gemini, retryAfterMs: 0, deadlineAt: now + 27_000, now })).toBe(false);
  });

  test("without a deadline there is always time for one retry", () => {
    expect(retryFits({ slot: gemini, retryAfterMs: 5000, deadlineAt: undefined, now })).toBe(true);
  });
});
