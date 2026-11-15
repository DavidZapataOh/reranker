import { expect, test, vi } from "vitest";
import { definitions, serveDefinitions } from "../test/definitions";
import { setupFlagsTests } from "../test/lifecycle";

vi.mock("@reranker/telemetry", () => ({ sendOpsAlert: vi.fn(async () => {}) }));

const { definitionsEtag, getFlagsClient, remembered } = await import("./client");

setupFlagsTests();

test("a result computed while definitions change is not remembered", async () => {
  serveDefinitions(definitions({ accounts: true }));
  const client = getFlagsClient();
  // Settles the initial load; a reload during it would join it instead of fetching again.
  await client.reloadFeatureFlags();
  const evaluate = () => client.evaluateFlags("house", { flagKeys: ["accounts"] });
  const before = definitionsEtag();
  await remembered("accounts|house", async () => {
    serveDefinitions(definitions({ accounts: false }));
    await client.reloadFeatureFlags();
    return evaluate();
  });
  expect(definitionsEtag()).not.toBe(before);
  const fresh = vi.fn(evaluate);
  await remembered("accounts|house", fresh);
  await remembered("accounts|house", fresh);
  expect(fresh).toHaveBeenCalledOnce();
});
