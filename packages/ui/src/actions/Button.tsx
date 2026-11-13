import type { ButtonHTMLAttributes } from "react";
import { type ButtonSize, type ButtonVariant, buttonClass } from "./variants.ts";

export function Button({
  variant,
  size,
  className,
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <button type={type} className={buttonClass(variant, size, className)} {...rest} />;
}
