// Google's terms forbid storing Places content, so a recording keeps the structure of an answer
// and the enum-like values that steer parsing, but no name, address or coordinate.
const KEPT = new Set(["types", "primaryType", "businessStatus", "languageCode"]);

export function shapeOf(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) return value.map((item) => shapeOf(item, key));
  if (value !== null && typeof value === "object") {
    // A country code is no Places content and decides whether a business is measurable.
    const country =
      "types" in value && Array.isArray(value.types) && value.types.includes("country");
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, country && k === "shortText" ? v : shapeOf(v, k)]),
    );
  }
  if (typeof value === "string") return KEPT.has(key) ? value : "x";
  if (typeof value === "number") return 0;
  return value;
}
