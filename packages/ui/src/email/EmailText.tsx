import type { ReactNode } from "react";
import { Text } from "react-email";

export function EmailText({
  tone = "default",
  small = false,
  last = false,
  children,
}: {
  tone?: "default" | "soft";
  small?: boolean;
  last?: boolean;
  children: ReactNode;
}) {
  const color = tone === "soft" ? "rr-soft text-ink-soft" : "rr-ink text-ink";
  const size = small ? "text-sm leading-5" : "text-base leading-6";
  return <Text className={`m-0 ${last ? "" : "mb-4"} ${size} ${color}`}>{children}</Text>;
}
