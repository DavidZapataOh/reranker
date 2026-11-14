import type { ReactNode } from "react";
import { Button } from "react-email";

// 12px padding around a 24px line gives the 48px touch target.
export function EmailButton({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Button
      href={href}
      className="box-border rounded-md bg-green px-6 py-3 text-center text-base leading-6 font-semibold text-white no-underline"
    >
      {children}
    </Button>
  );
}
