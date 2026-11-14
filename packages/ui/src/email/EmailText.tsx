import type { ReactNode } from "react";
import { Text } from "react-email";

export function EmailText({
  tone = "default",
  children,
}: {
  tone?: "default" | "soft";
  children: ReactNode;
}) {
  return (
    <Text
      className={`m-0 mb-4 text-base leading-6 ${tone === "soft" ? "text-ink-soft" : "text-ink"}`}
    >
      {children}
    </Text>
  );
}
