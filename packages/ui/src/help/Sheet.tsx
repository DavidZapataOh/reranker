"use client";

import {
  type ButtonHTMLAttributes,
  cloneElement,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { buttonClass } from "../actions/variants.ts";
import { copy } from "../copy.ts";

const focusable = "a[href], button:not(:disabled), [tabindex='0']";

// Chromium lets Tab leave a modal dialog for the browser UI; wrapping keeps it on the sheet.
function wrapTab(event: KeyboardEvent<HTMLDialogElement>) {
  if (event.key !== "Tab") return;
  const items = event.currentTarget.querySelectorAll<HTMLElement>(focusable);
  const edge = items[event.shiftKey ? 0 : items.length - 1];
  if (document.activeElement !== edge) return;
  event.preventDefault();
  items[event.shiftKey ? items.length - 1 : 0]?.focus();
}

// The native dialog supplies the focus trap, inert page, Escape and focus return; React only mirrors its state.
export function Sheet({
  trigger,
  title,
  children,
}: {
  trigger: ReactElement<ButtonHTMLAttributes<HTMLButtonElement>>;
  title: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const dialogId = useId();
  const titleId = useId();

  // Portaled so a term inside a paragraph never nests block content in a <p>.
  useEffect(() => setHost(document.body), []);

  const opener = cloneElement(trigger, {
    onClick: (event: MouseEvent<HTMLButtonElement>) => {
      trigger.props.onClick?.(event);
      if (event.defaultPrevented) return;
      ref.current?.showModal();
      setOpen(true);
    },
    "aria-haspopup": "dialog",
    "aria-expanded": open,
    "aria-controls": dialogId,
  });

  return (
    <>
      {opener}
      {host &&
        createPortal(
          <dialog
            ref={ref}
            id={dialogId}
            aria-labelledby={titleId}
            onClose={() => setOpen(false)}
            onKeyDown={wrapTab}
            onClick={(event) => {
              if (event.target === ref.current) ref.current?.close();
            }}
            className="fixed inset-x-0 top-auto bottom-0 m-0 md:top-0 md:bottom-0 max-h-[85dvh] w-full max-w-none flex-col rounded-t-3xl bg-surface p-0 text-ink shadow-lift backdrop:bg-ink/40 open:flex md:inset-y-0 md:mx-auto md:my-auto md:max-w-md md:rounded-3xl"
          >
            <div
              data-sheet-body
              // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must take keyboard focus so long definitions can be scrolled
              tabIndex={0}
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-6"
            >
              <h2 id={titleId} className="text-[20px] font-semibold leading-snug">
                {title}
              </h2>
              <div className="mt-3 text-[16px] leading-relaxed text-ink-soft">{children}</div>
            </div>
            <div className="p-6 pt-3">
              <form method="dialog">
                <button type="submit" className={buttonClass("secondary", "lg", "w-full")}>
                  {copy.sheet.close}
                </button>
              </form>
            </div>
          </dialog>,
          host,
        )}
    </>
  );
}
