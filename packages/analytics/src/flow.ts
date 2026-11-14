import { z } from "@reranker/schema";

export type FlowContext = {
  visitId: string;
  origin: {
    ai_source: string | null;
    utm_source: string | null;
    utm_medium: string | null;
    utm_campaign: string | null;
    device_type: "mobile" | "tablet" | "desktop";
    landing_path: string;
  };
  consent: "granted" | "denied" | "pending";
};

export type EventSubject =
  | { report: string }
  | { lead: string }
  | { user: string }
  | { system: true };

export type CaptureContext = { headers?: Headers; flow?: FlowContext; subject: EventSubject };

const utm = z.string().max(200).nullable();

export const flowContextSchema = z
  .object({
    visitId: z.uuid(),
    origin: z
      .object({
        ai_source: z.string().max(40).nullable(),
        utm_source: utm,
        utm_medium: utm,
        utm_campaign: utm,
        device_type: z.enum(["mobile", "tablet", "desktop"]),
        landing_path: z.string().startsWith("/").max(300),
      })
      .strict(),
    consent: z.enum(["granted", "denied", "pending"]),
  })
  .strict() satisfies z.ZodType<FlowContext>;

// Analytics context is best-effort: a malformed value must never fail the enclosing request.
export const flowContextField = flowContextSchema.optional().catch(undefined);
