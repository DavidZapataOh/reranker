import type { BrowserCommand } from "vitest/node";

type ReducedMotion = "reduce" | "no-preference";

declare module "vitest/browser" {
  interface BrowserCommands {
    emulateReducedMotion: (value: ReducedMotion) => Promise<void>;
  }
}

export const emulateReducedMotion: BrowserCommand<[ReducedMotion]> = async (ctx, value) => {
  if (ctx.provider.name !== "playwright") {
    throw new Error(`emulateReducedMotion needs the playwright provider, got ${ctx.provider.name}`);
  }
  await ctx.page.emulateMedia({ reducedMotion: value });
};
