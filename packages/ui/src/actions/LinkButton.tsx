import type { AnchorHTMLAttributes } from "react";
import { type ButtonSize, type ButtonVariant, buttonClass } from "./variants.ts";

export function LinkButton({
  variant,
  size,
  className,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <a className={buttonClass(variant, size, className)} {...rest} />;
}
