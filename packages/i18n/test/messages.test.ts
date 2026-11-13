import IntlMessageFormat from "intl-messageformat";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import esCO from "../messages/es-CO.json" with { type: "json" };
import { getTranslator } from "../src/index";

type Tree = { readonly [key: string]: string | Tree };
type Params = Record<string, string | number | Date>;

function flatten(tree: Tree, prefix = ""): [string, string][] {
  return Object.entries(tree).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof value === "string" ? [[path, value] as [string, string]] : flatten(value, path);
  });
}

// Structural view of the ICU AST: argument kinds are numbered by @formatjs/icu-messageformat-parser.
type Element = {
  readonly type: number;
  readonly value?: unknown;
  readonly options?: Readonly<Record<string, { readonly value: readonly Element[] }>>;
  readonly children?: readonly Element[];
};
const ARGUMENT = 1;
const NUMBER = 2;
const DATE = 3;
const TIME = 4;
const SELECT = 5;
const PLURAL = 6;
const TAG = 8;

type Argument = {
  readonly name: string;
  readonly select?: readonly string[];
  readonly temporal?: boolean;
};

function collectArguments(elements: readonly Element[], found = new Map<string, Argument>()) {
  for (const el of elements) {
    if (el.type === SELECT && typeof el.value === "string") {
      found.set(el.value, { name: el.value, select: Object.keys(el.options ?? {}) });
    } else if ((el.type === DATE || el.type === TIME) && typeof el.value === "string") {
      found.set(el.value, { name: el.value, temporal: true });
    } else if (
      (el.type === ARGUMENT || el.type === NUMBER || el.type === PLURAL) &&
      typeof el.value === "string" &&
      !found.has(el.value)
    ) {
      found.set(el.value, { name: el.value });
    }
    for (const option of Object.values(el.options ?? {})) collectArguments(option.value, found);
    if (el.type === TAG && el.children) collectArguments(el.children, found);
  }
  return [...found.values()];
}

function valueFor(arg: Argument, n: number): string | number | Date {
  if (arg.select) return arg.select[0] ?? "other";
  if (arg.temporal) return new Date(Date.UTC(2026, 10, 5, 3));
  return n;
}

// Every select branch and the plural categories 0, 1 and 2 are rendered at least once.
function representativeParams(message: string): Params[] {
  const args = collectArguments(new IntlMessageFormat(message, "es-CO").getAst() as Element[]);
  const sets: Params[] = [0, 1, 2].map((n) =>
    Object.fromEntries(args.map((a) => [a.name, valueFor(a, n)])),
  );
  for (const arg of args) {
    for (const option of arg.select ?? []) sets.push({ ...sets[2], [arg.name]: option });
  }
  return sets;
}

const entries = flatten(esCO);
const errorCodes = Object.keys(esCO.errors).filter((key) => key !== "validation");
const renderedEntries = entries.flatMap(([key, message]) =>
  representativeParams(message).map(
    (params) => [key, new IntlMessageFormat(message, "es-CO").format(params) as string] as const,
  ),
);

test("required namespaces exist", () => {
  expect(Object.keys(esCO)).toEqual(expect.arrayContaining(["common", "errors", "auth", "legal"]));
});

test("every message compiles as ICU", () => {
  for (const [key, message] of entries) {
    expect(() => new IntlMessageFormat(message, "es-CO"), key).not.toThrow();
  }
});

describe("no message exposes technical language", () => {
  test("no ICU syntax survives formatting", () => {
    for (const [key, text] of renderedEntries) expect(text, key).not.toMatch(/[{}]/);
  });

  test("no error code, snake_case identifier or HTTP vocabulary", () => {
    for (const [key, text] of renderedEntries) {
      for (const code of errorCodes)
        expect(text, key).not.toMatch(new RegExp(`\\b${code}\\b`, "i"));
      expect(text, key).not.toMatch(/\b[a-z0-9]+(?:_[a-z0-9]+)+\b/i);
      expect(text, key).not.toMatch(
        /\b(error \d{3}|HTTP|status|null|undefined|NaN|OTP|token|API|JSON)\b/i,
      );
    }
  });

  test("no web address", () => {
    for (const [key, text] of renderedEntries) {
      expect(text, key).not.toMatch(/https?:\/\/\S|\bwww\.|\.(co|com)\/\S/i);
    }
  });

  test("no English", () => {
    for (const [key, text] of renderedEntries) {
      expect(text, key).not.toMatch(
        /\b(the|and|please|click|submit|sign in|log in|email|link|retry|failed|invalid|required|not found|try again|loading|cancel|save)\b/i,
      );
    }
  });

  test("never sends the customer to a person", () => {
    for (const [key, text] of renderedEntries) {
      expect(text, key).not.toMatch(
        /soporte|contact|ll[aá]ma(nos|r)|escr[ií]be(nos|r a)|agend|reuni[oó]n|asesor|whatsapp|\bdemo\b/i,
      );
    }
  });
});

describe("the translator renders every message", () => {
  const logged = vi.fn();
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(logged);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("without falling back or logging", () => {
    for (const [key, message] of entries) {
      const [namespace = "", ...rest] = key.split(".");
      const t = getTranslator("es-CO", namespace as "common");
      for (const params of representativeParams(message)) {
        const text = t(rest.join(".") as "appName", params);
        expect(text, key).not.toContain(key);
        expect(text, key).not.toMatch(/[{}]/);
      }
    }
    expect(logged).not.toHaveBeenCalled();
  });
});
