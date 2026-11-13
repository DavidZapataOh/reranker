import { renderToStaticMarkup as html } from "react-dom/server";
import { expect, test } from "vitest";
import { Icon, icons } from "./icons.tsx";

test("Icon draws a decorative 2px stroke path at 24px by default", () => {
  expect(html(<Icon d={icons.check} />)).toBe(
    `<svg aria-hidden="true" viewBox="0 0 24 24" class="h-6 w-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${icons.check}"></path></svg>`,
  );
  expect(html(<Icon d={icons.arrow} className="h-4 w-4" />)).toContain('class="h-4 w-4"');
});
