import { BANNED_PROPERTY_KEYS } from "@reranker/analytics";
import { appEnv } from "@reranker/env";
import type { BeforeSendFn } from "posthog-node";

/** The personal-data deny list is owned by analytics so the event catalog and this scrubber never drift. */
export const FORBIDDEN_KEYS: readonly string[] = BANNED_PROPERTY_KEYS;

const REDACTED = "[redacted]";
const CIRCULAR = "[circular]";
const TRUNCATED = "[truncated]";
// Deeper than any real payload; it only exists so a pathological object cannot exhaust the stack.
const MAX_DEPTH = 32;

const forbidden = new Set(FORBIDDEN_KEYS.map((key) => key.toLowerCase()));

const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
// Country codes with customers today (+57, +52, +34, +1), in any spacing or grouping.
const INTERNATIONAL_PHONE = /\+(?:57|52|34|1)[\d\s().-]{6,18}\d/g;
// Colombian mobiles written without the plus sign, with or without the country code.
const COLOMBIAN_PHONE = /(?<!\d)(?:57[\s-]?)?3\d{2}[\s-]?\d{3}[\s-]?\d{4}(?!\d)/g;

function redactString(value: string): string {
  return value
    .replace(EMAIL, REDACTED)
    .replace(INTERNATIONAL_PHONE, REDACTED)
    .replace(COLOMBIAN_PHONE, REDACTED);
}

function isForbidden(key: unknown): boolean {
  return typeof key === "string" && forbidden.has(key.toLowerCase());
}

type Path = WeakSet<object>;

function hidden(target: object, key: string, value: unknown) {
  Object.defineProperty(target, key, { value, writable: true, configurable: true });
}

function walkError(error: Error, depth: number, path: Path): Error {
  const copy: Error = Object.create(Object.getPrototypeOf(error));
  hidden(copy, "message", redactString(error.message));
  if (typeof error.stack === "string") hidden(copy, "stack", redactString(error.stack));
  if (Object.hasOwn(error, "name")) hidden(copy, "name", error.name);
  if ("cause" in error) hidden(copy, "cause", walk(error.cause, depth + 1, path));
  const { errors } = error as { errors?: unknown };
  if (Array.isArray(errors)) hidden(copy, "errors", walk(errors, depth + 1, path));
  for (const [key, value] of Object.entries(error)) {
    (copy as unknown as Record<string, unknown>)[key] = isForbidden(key)
      ? REDACTED
      : walk(value, depth + 1, path);
  }
  return copy;
}

function walk(value: unknown, depth: number, path: Path): unknown {
  if (typeof value === "string") return redactString(value);
  if (typeof value !== "object" || value === null) return value;
  if (value instanceof Date || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return value;
  }
  if (path.has(value)) return CIRCULAR;
  if (depth > MAX_DEPTH) return TRUNCATED;

  // Only the ancestors of the current node count as a cycle, so a shared reference is scrubbed in full both times.
  path.add(value);
  try {
    if (value instanceof Error) return walkError(value, depth, path);
    if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1, path));
    if (value instanceof Set) return new Set([...value].map((item) => walk(item, depth + 1, path)));
    if (value instanceof Map) {
      return new Map(
        [...value].map(([key, item]) => [
          walk(key, depth + 1, path),
          isForbidden(key) ? REDACTED : walk(item, depth + 1, path),
        ]),
      );
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        isForbidden(key) ? REDACTED : walk(item, depth + 1, path),
      ]),
    );
  } finally {
    path.delete(value);
  }
}

/** Deep copy with personal data redacted: forbidden keys at any depth, emails and phones inside strings, and every part of an Error. */
export function scrub<T>(value: T): T {
  return walk(value, 0, new WeakSet()) as T;
}

/** For `before_send` of posthog-node and `beforeCapture` of @posthog/next: every event leaves without IP, geo or personal data. */
export const scrubEvent: BeforeSendFn = (event) => {
  const properties: Record<string, unknown> = { ...event.properties };
  delete properties.$ip;
  return {
    ...event,
    ...(event.distinctId === undefined ? {} : { distinctId: scrub(event.distinctId) }),
    properties: scrub({ ...properties, $geoip_disable: true, app_env: appEnv() }),
  };
};
