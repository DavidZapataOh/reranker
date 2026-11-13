import type { ReactNode } from "react";

const kinds = {
  self: "marker font-semibold text-ink",
  competitor: "bg-transparent font-semibold text-ink",
} as const;

export function Highlight({
  kind,
  children,
}: {
  kind: "self" | "competitor";
  children: ReactNode;
}) {
  return <mark className={kinds[kind]}>{children}</mark>;
}
