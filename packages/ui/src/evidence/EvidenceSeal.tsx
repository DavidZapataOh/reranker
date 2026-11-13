import { copy } from "../copy.ts";
import { cx } from "../cx.ts";

export type EvidenceSealProps = { variant: "stamp"; className?: string };

export function EvidenceSeal({ className }: EvidenceSealProps) {
  const [first, second] = copy.seal.stampLines;
  return (
    <span
      className={cx(
        "grid h-[74px] w-[74px] rotate-[-12deg] place-items-center rounded-full bg-amber text-center font-display text-[11px] leading-tight font-black text-ink shadow-soft",
        className,
      )}
    >
      {first}
      <br />
      {second}
    </span>
  );
}
