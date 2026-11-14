import { captureServerEvent } from "../src/events";

// Compiled by `tsc --noEmit`, never run: a leaking event literal must fail the type check.
captureServerEvent(
  { name: "report_failed", props: { report_id: "fr_1", error_code: "internal", duration_s: 1 } },
  { subject: { report: "fr_1" } },
);

captureServerEvent(
  // @ts-expect-error report_requested has no business_name, and its required props are missing
  { name: "report_requested", props: { business_name: "x" } },
  { subject: { system: true } },
);

captureServerEvent(
  // @ts-expect-error an unknown event name
  { name: "not_an_event", props: {} },
  { subject: { system: true } },
);

captureServerEvent(
  { name: "lead_unsubscribed", props: { lead_id: "ld_1" } },
  // @ts-expect-error the subject is required
  {},
);
