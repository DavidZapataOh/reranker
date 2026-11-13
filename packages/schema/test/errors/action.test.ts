import { expect, test } from "vitest";
import { AppError, toActionResult } from "../../src/index";

test("toActionResult turns thrown errors into serializable problems", async () => {
  const r = await toActionResult(
    async () => {
      throw new AppError("turnstile_failed");
    },
    { locale: "es-CO" },
  );
  expect(r).toMatchObject({ ok: false, problem: { code: "turnstile_failed", status: 403 } });
  expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  expect(
    await toActionResult(
      async () => {
        throw new Error("boom");
      },
      { locale: "es-CO" },
    ),
  ).toMatchObject({ ok: false, problem: { code: "internal" } });
  expect(await toActionResult(async () => 7, { locale: "es-CO" })).toEqual({ ok: true, data: 7 });
});

test("toActionResult lets control-flow errors through", async () => {
  const redirect = Object.assign(new Error("NEXT_REDIRECT"), {
    digest: "NEXT_REDIRECT;replace;/app;307;",
  });
  await expect(
    toActionResult(
      async () => {
        throw redirect;
      },
      {
        locale: "es-CO",
        rethrow: (e) => {
          if (e === redirect) throw e;
        },
      },
    ),
  ).rejects.toBe(redirect);
});

test("rethrow that returns lets the error become a problem", async () => {
  const seen: unknown[] = [];
  const r = await toActionResult(
    async () => {
      throw new AppError("conflict");
    },
    { locale: "es-CO", rethrow: (e) => void seen.push(e) },
  );
  expect(seen).toHaveLength(1);
  expect(r).toMatchObject({ ok: false, problem: { code: "conflict" } });
});

test("onError sees unexpected errors only", async () => {
  const seen: unknown[] = [];
  const onError = (e: unknown) => void seen.push(e);
  const boom = new Error("boom");
  const redirect = new Error("NEXT_REDIRECT");
  const rethrow = (e: unknown) => {
    if (e === redirect) throw e;
  };
  const failWith = (e: unknown) => async () => {
    throw e;
  };
  expect(await toActionResult(failWith(boom), { locale: "es-CO", onError })).toMatchObject({
    ok: false,
    problem: { code: "internal" },
  });
  await toActionResult(failWith(new AppError("conflict")), { locale: "es-CO", onError });
  await toActionResult(async () => 1, { locale: "es-CO", onError });
  await expect(
    toActionResult(failWith(redirect), { locale: "es-CO", rethrow, onError }),
  ).rejects.toBe(redirect);
  expect(seen).toEqual([boom]);
});
