import type { JobsTelemetry } from "@reranker/jobs";
import { captureServerEvent, sendOpsAlert } from "@reranker/telemetry";

// The jobs package cannot import telemetry (it pulls in Next), so the app hands it this sink.
export const jobsTelemetry: JobsTelemetry = {
  capture: (event) => captureServerEvent(event, { subject: { system: true } }),
  alert: (kind, payload) => sendOpsAlert(kind, payload),
};
