import type { Page } from "@playwright/test";

export type Shift = { start: number; value: number; hadRecentInput: boolean; inHero: boolean };

// Installed before any page script so no shift escapes, however early it happens.
export async function recordShifts(page: Page) {
  await page.addInitScript(() => {
    type Entry = PerformanceEntry & {
      value: number;
      hadRecentInput: boolean;
      sources?: { node?: Node | null }[];
    };
    const shifts: Shift[] = [];
    Object.assign(window, { __shifts: shifts });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as Entry[]) {
        const hero = document.getElementById("reporte");
        shifts.push({
          start: entry.startTime,
          value: entry.value,
          hadRecentInput: entry.hadRecentInput,
          inHero: !!entry.sources?.some((s) => s.node && hero?.contains(s.node)),
        });
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
}

export const shiftsSince = (page: Page, since: number) =>
  page.evaluate(
    (after: number) =>
      (window as unknown as { __shifts: Shift[] }).__shifts.filter(
        (s) => s.start > after && !s.hadRecentInput,
      ),
    since,
  );

export const clsSince = async (page: Page, since: number) =>
  (await shiftsSince(page, since)).reduce((total, s) => total + s.value, 0);
