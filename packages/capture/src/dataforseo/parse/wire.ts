import type { EngineAnswer } from "../../answer";

type Source = EngineAnswer["sources"][number];

// Fatal decoding: a body that is not UTF-8 is an error to record, not text to guess at.
const utf8 = new TextDecoder("utf-8", { fatal: true });

/** The first result of the first task, the shape shared by Live and task_get/advanced. */
export function firstResult<T>(bytes: Uint8Array): T {
  const body = JSON.parse(utf8.decode(bytes)) as { tasks?: { result?: T[] | null }[] | null };
  const result = body.tasks?.[0]?.result?.[0];
  if (result === null || typeof result !== "object") {
    throw new Error("the response holds no result");
  }
  return result;
}

export const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

export const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export const field = (value: unknown, key: string): unknown =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;

function hostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/**
 * Sources in answer order, one per URL: the cited ones first, then whatever else the engine
 * retrieved. Entries without a URL carry nothing to attribute and are skipped.
 */
export function sources(cited: unknown[], retrieved: unknown[] = []): Source[] {
  const out = new Map<string, Source>();
  const add = (entry: unknown, isCited: boolean) => {
    const url = text(field(entry, "url"));
    if (url === undefined || out.has(url)) return;
    const title = text(field(entry, "title"));
    out.set(url, {
      url,
      domain: text(field(entry, "domain")) ?? hostname(url),
      ...(title === undefined ? {} : { title }),
      cited: isCited,
    });
  };
  for (const entry of cited) add(entry, true);
  for (const entry of retrieved) add(entry, false);
  return [...out.values()];
}

export const queries = (value: unknown): string[] =>
  list(value).filter((q): q is string => text(q) !== undefined);
