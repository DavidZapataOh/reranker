export type PublicRoute = { path: string; name: string; budgetKey: string; screen: string };

export const publicRoutes: PublicRoute[] = [
  { path: "/", name: "home", budgetKey: "landing", screen: "landing" },
  { path: "/terminos", name: "terms", budgetKey: "legal", screen: "terms" },
  { path: "/politica-de-datos", name: "data-policy", budgetKey: "legal", screen: "data-policy" },
];

const TARGETS = ["local", "preview", "production"] as const;

export type AppTarget = (typeof TARGETS)[number];

export function readTarget(value = "local"): AppTarget {
  const target = TARGETS.find((t) => t === value);
  if (!target)
    throw new Error(`Unknown APP_TARGET "${value}". Expected one of: ${TARGETS.join(", ")}.`);
  return target;
}

export const appTarget: AppTarget = readTarget(process.env.APP_TARGET);
