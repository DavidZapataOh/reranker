import type {
  BannedKey,
  CLIENT_EVENT_KEYS,
  ClientEventMap,
  ClientEventName,
  SERVER_EVENT_KEYS,
  ServerEventMap,
  ServerEventName,
  ServerEventOf,
  ServerEventProps,
} from "../src/events";

// Compiled by `tsc --noEmit`, never run: a leaking event literal must fail the type check.
declare function emit<N extends ServerEventName>(event: ServerEventOf<N>): void;
declare const viewed: ServerEventProps<"report_viewed">;

emit({ name: "report_viewed", props: viewed });
emit({
  name: "report_failed",
  props: { report_id: "fr_1", error_code: "internal", duration_s: 1 },
});
// @ts-expect-error a banned key in an event literal must not compile
emit({ name: "report_viewed", props: { ...viewed, business_name: "x" } });
// @ts-expect-error an unlisted property must not compile
emit({ name: "report_viewed", props: { ...viewed, favorite_color: "red" } });
// @ts-expect-error unknown event names must not compile
emit({ name: "report_seen", props: {} });
// @ts-expect-error required props are required
emit({ name: "report_failed", props: { report_id: "fr_1", duration_s: 1 } });

type Leak =
  | { [N in ServerEventName]: Extract<keyof ServerEventMap[N], BannedKey> }[ServerEventName]
  | { [N in ClientEventName]: Extract<keyof ClientEventMap[N], BannedKey> }[ClientEventName];
export const noLeak: [Leak] extends [never] ? true : false = true;

type Missing =
  | {
      [N in ServerEventName]: Exclude<
        keyof ServerEventMap[N],
        (typeof SERVER_EVENT_KEYS)[N][number]
      >;
    }[ServerEventName]
  | {
      [N in ClientEventName]: Exclude<
        keyof ClientEventMap[N],
        (typeof CLIENT_EVENT_KEYS)[N][number]
      >;
    }[ClientEventName];
export const complete: [Missing] extends [never] ? true : false = true;
