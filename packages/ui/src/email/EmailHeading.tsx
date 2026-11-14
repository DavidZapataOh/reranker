import type { ReactNode } from "react";
import { Heading } from "react-email";

export function EmailHeading({ children }: { children: ReactNode }) {
  return (
    <Heading
      as="h1"
      className="m-0 mb-4 font-display text-[28px] leading-9 font-extrabold text-ink"
    >
      {children}
    </Heading>
  );
}
