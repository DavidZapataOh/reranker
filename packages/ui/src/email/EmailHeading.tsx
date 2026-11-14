import type { ReactNode } from "react";
import { Heading } from "react-email";

export function EmailHeading({ children }: { children: ReactNode }) {
  return (
    <Heading
      as="h1"
      className="rr-ink m-0 mb-6 font-display text-2xl leading-8 font-extrabold text-ink"
    >
      {children}
    </Heading>
  );
}
