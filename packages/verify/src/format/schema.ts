import * as z from "zod/mini";
import { type CaptureId, isCaptureId } from "./ids";

export const sha256Hex = z.string().check(z.regex(/^[0-9a-f]{64}$/));

export const captureIdSchema = z.custom<CaptureId>(
  (value) => typeof value === "string" && isCaptureId(value),
);
