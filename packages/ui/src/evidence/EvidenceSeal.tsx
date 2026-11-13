import { LinkButton } from "../actions/LinkButton.tsx";
import { copy } from "../copy.ts";
import { cx } from "../cx.ts";
import { Sheet } from "../help/Sheet.tsx";
import { assertVerifyUrl } from "./verifyUrl.ts";

export type EvidenceSealProps =
  | { variant?: "inline"; capturedAtLabel: string; cityLabel: string; verifyUrl: string }
  | { variant: "stamp"; className?: string };

function Stamp({ className }: { className?: string | undefined }) {
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

function Inline({
  capturedAtLabel,
  cityLabel,
  verifyUrl,
}: {
  capturedAtLabel: string;
  cityLabel: string;
  verifyUrl: string;
}) {
  const href = assertVerifyUrl(verifyUrl);
  return (
    <div data-seal className="flex items-center gap-2 font-mono text-[13px] leading-snug text-ink">
      <svg
        viewBox="0 0 24 24"
        width="20"
        height="20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className="shrink-0"
      >
        <circle cx="12" cy="12" r="9.5" />
        <circle cx="12" cy="12" r="6.5" strokeDasharray="1.5 2" />
        <path d="m9 12.2 2.1 2.1L15.2 10" />
      </svg>
      <span className="min-w-0 [overflow-wrap:anywhere]">
        {copy.seal.inline(capturedAtLabel, cityLabel)}
      </span>
      <Sheet
        title={copy.seal.title}
        trigger={
          <button
            type="button"
            aria-label={copy.seal.help}
            className="-my-3 grid size-12 shrink-0 place-items-center rounded-full"
          >
            <span
              aria-hidden="true"
              className="grid size-6 place-items-center rounded-full font-sans text-[14px] font-bold ring-1 ring-ink/40"
            >
              ?
            </span>
          </button>
        }
      >
        <p>{copy.seal.explainer}</p>
        <LinkButton href={href} size="lg" className="mt-5 w-full">
          {copy.seal.verify}
        </LinkButton>
      </Sheet>
    </div>
  );
}

export function EvidenceSeal(props: EvidenceSealProps) {
  return props.variant === "stamp" ? <Stamp className={props.className} /> : <Inline {...props} />;
}
