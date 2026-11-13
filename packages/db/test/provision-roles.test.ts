import { expect, test } from "vitest";
import { parseLoginPasswords } from "../scripts/provision-roles";

const strong = "f3a9c1d27b8e4056a1c2d3e4f5061728394a5b6c7d8e9f01";

test("rejects DB_LOGIN_PASSWORDS missing a login or with a password under 60 bits of entropy", () => {
  expect(() => parseLoginPasswords('{"reranker_app":"short"}')).toThrow(/reranker_system/);
  expect(() =>
    parseLoginPasswords(`{"reranker_app":"aaaaaaaa","reranker_system":"${strong}"}`),
  ).toThrow(/entropy/);
});

test("accepts the two-login json the pipeline builds", () => {
  const raw = JSON.stringify({ reranker_app: strong, reranker_system: `${strong}x` });
  expect(parseLoginPasswords(raw)).toEqual({ reranker_app: strong, reranker_system: `${strong}x` });
});

test("rejects unset, malformed, non-object and unknown-login input without echoing values", () => {
  expect(() => parseLoginPasswords(undefined)).toThrow(/not set/);
  expect(() => parseLoginPasswords("{nope")).toThrow(/JSON object/);
  expect(() => parseLoginPasswords("[]")).toThrow(/JSON object/);
  const raw = JSON.stringify({
    reranker_app: strong,
    reranker_system: strong,
    other: "secretvalue",
  });
  expect(() => parseLoginPasswords(raw)).toThrow(/unknown logins: other/);
  const weak = '{"reranker_app":"hunter2","reranker_system":"%s"}'.replace("%s", strong);
  expect(() => parseLoginPasswords(weak)).toThrow(/entropy/);
  try {
    parseLoginPasswords(weak);
  } catch (error) {
    expect((error as Error).message).not.toContain("hunter2");
  }
});
