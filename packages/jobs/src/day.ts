import { DEFAULT_COUNTRY_CODE, getCountry } from "@reranker/i18n/countries";

// The spend day is the priority country's day, so operators read the same date the budget does.
const TIME_ZONE = getCountry(DEFAULT_COUNTRY_CODE).timeZone;

const dateFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

// sv-SE prints `YYYY-MM-DD HH:mm:ss`, which Date can parse back as a UTC instant.
const clockFormat = new Intl.DateTimeFormat("sv-SE", {
  timeZone: TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** Local calendar day as `YYYY-MM-DD`. */
export function spendDay(now: Date = new Date()): string {
  return dateFormat.format(now);
}

function offsetMs(instant: number): number {
  const local = Date.parse(`${clockFormat.format(instant).replace(" ", "T")}Z`);
  return local - Math.floor(instant / 1000) * 1000;
}

/** The instant the next local day starts, when daily counters roll over. */
export function nextResetAt(now: Date = new Date()): Date {
  const nextMidnightAsUtc = Date.parse(`${spendDay(now)}T00:00:00Z`) + 86_400_000;
  // Two passes so a zone that changes offset that night still lands on local midnight.
  const first = nextMidnightAsUtc - offsetMs(nextMidnightAsUtc);
  return new Date(nextMidnightAsUtc - offsetMs(first));
}
