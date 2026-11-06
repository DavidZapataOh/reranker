import { expect, it, vi } from "vitest";
import { countLiveCiBranches, waitForCiBranchSlot } from "./neon-branch-slot.ts";

const branches = (n: number) => ({
  branches: [{ name: "main" }, ...Array.from({ length: n }, (_, i) => ({ name: `ci/run-${i}-1` }))],
});
const fakeFetch = (...pages: number[]) =>
  vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    Response.json(branches(pages.shift() ?? 0)),
  );

it("counts only ci/ branches", () => expect(countLiveCiBranches(branches(3).branches)).toBe(3));

it("returns immediately when fewer than 8 are live", async () => {
  const sleep = vi.fn(async () => {});
  expect(
    await waitForCiBranchSlot({ apiKey: "k", projectId: "p", fetch: fakeFetch(7), sleep }),
  ).toEqual({ live: 7, attempt: 1 });
  expect(sleep).not.toHaveBeenCalled();
});

it("waits 60 s between attempts until a slot frees", async () => {
  const sleep = vi.fn(async () => {});
  expect(
    await waitForCiBranchSlot({ apiKey: "k", projectId: "p", fetch: fakeFetch(8, 8, 7), sleep }),
  ).toEqual({ live: 7, attempt: 3 });
  expect(sleep).toHaveBeenCalledTimes(2);
  expect(sleep).toHaveBeenCalledWith(60_000);
});

it("gives up after 5 attempts", async () => {
  await expect(
    waitForCiBranchSlot({
      apiKey: "k",
      projectId: "p",
      fetch: fakeFetch(8, 8, 8, 8, 8),
      sleep: async () => {},
    }),
  ).rejects.toThrow("No free Neon CI branch slot after 5 attempts (8 live)");
});

it("calls the Neon API with the bearer key", async () => {
  const f = fakeFetch(0);
  await waitForCiBranchSlot({ apiKey: "k", projectId: "p", fetch: f, sleep: async () => {} });
  expect(f).toHaveBeenCalledWith(
    "https://console.neon.tech/api/v2/projects/p/branches",
    expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer k" }) }),
  );
});

it("fails loudly on a non-2xx API response", async () => {
  const f = vi.fn(async () => new Response("unauthorized", { status: 401 }));
  await expect(
    waitForCiBranchSlot({ apiKey: "k", projectId: "p", fetch: f, sleep: async () => {} }),
  ).rejects.toThrow("Neon API 401");
});
