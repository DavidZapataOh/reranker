import type { GatedFlag, LaunchCheckId } from "./launch/types";

type Stage = { name: string; cost: string; trigger: string };

/** Verified by `launch:check`; its trigger fires once one of its gated flags is on in production. */
type LaunchStage = Stage & { checks: readonly LaunchCheckId[]; gates: readonly GatedFlag[] };

/** Fired by a daily volume trigger with its own alert and runbook. */
type VolumeStage = Stage & { volume: "spendCapPressure" | "primitiveLatency" | "providerVolume" };

/** Enforced by a gate outside this code, which the digest names. */
type ExternalStage = Stage & { verifiedBy: string };

const BEFORE_BOTH = "antes de free-report-live o accounts";
const BEFORE_FREE_REPORT = "antes de free-report-live";
const FREE_REPORT: readonly GatedFlag[] = ["free-report-live"];

/** Every provider tier upgrade with its trigger and cost, in Spanish: the founder reads them. */
export const PENDING_STAGES: readonly (LaunchStage | VolumeStage | ExternalStage)[] = [
  {
    name: "Neon de producción siempre encendido, 0,5–4 CU, 7 días de restauración, rama protegida",
    cost: "≈ US$40/mes",
    trigger: BEFORE_BOTH,
    checks: ["neon-production"],
    gates: ["free-report-live", "accounts"],
  },
  {
    name: "Resend Pro con cupos recalculados",
    cost: "US$20/mes",
    trigger: BEFORE_BOTH,
    checks: ["resend-plan"],
    gates: ["free-report-live", "accounts"],
  },
  {
    name: "/api/ready monitoreado en Better Stack cada 30 s, alertas críticas a la guardia",
    cost: "incluido en US$34/mes",
    trigger: BEFORE_FREE_REPORT,
    checks: ["betterstack-ready", "betterstack-routing"],
    gates: FREE_REPORT,
  },
  {
    name: "Trazas con @vercel/otel y Observability Plus",
    cost: "≈ US$10/mes + uso",
    trigger: BEFORE_FREE_REPORT,
    checks: ["traces"],
    gates: FREE_REPORT,
  },
  {
    name: "PostHog con pago por uso, sin tope de 5 alertas, producción y preview separados",
    cost: "US$0 fijo + uso",
    trigger: BEFORE_FREE_REPORT,
    checks: ["posthog-billing", "posthog-projects"],
    gates: FREE_REPORT,
  },
  {
    name: "Repo en organización privada de GLEMO con Team + GHAS",
    cost: "≈ US$55–80/mes",
    trigger: BEFORE_FREE_REPORT,
    checks: ["github-private-org"],
    gates: FREE_REPORT,
  },
  {
    name: "Clave de Resend de producción de solo envío",
    cost: "US$0",
    trigger: BEFORE_FREE_REPORT,
    checks: ["resend-sending-key"],
    gates: FREE_REPORT,
  },
  {
    name: "Pruebas de humo por motor cada 15 min",
    cost: "uso ≈ US$0,3/día",
    trigger: BEFORE_FREE_REPORT,
    checks: ["smoke-cron"],
    gates: FREE_REPORT,
  },
  {
    name: "Canario en los 4 motores, clave de firma en AWS KMS y anotadores humanos del gold set",
    cost: "≈ US$60/mes + ≈ US$2/mes + ≈ US$300–450 una vez",
    trigger: BEFORE_FREE_REPORT,
    verifiedBy: "lo verifican las puertas de precisión y de calidad del producto",
  },
  {
    name: "Rolling Releases + release-gate y prioridad pago > gratis en los leases",
    cost: "incluido en Pro",
    trigger: "antes de la primera venta",
    verifiedBy: "lo verifica la puerta de la primera venta",
  },
  {
    name: "Tope del reporte gratis por demanda",
    cost: "según demanda",
    trigger: "uso del tope ≥ 70 % tres días seguidos",
    volume: "spendCapPressure",
  },
  {
    name: "Valkey para buckets, leases y breaker",
    cost: "según proveedor",
    trigger: "p95 de las primitivas > 25 ms una semana",
    volume: "primitiveLatency",
  },
  {
    name: "Temporal",
    cost: "según proveedor",
    trigger: "> 2M llamadas a proveedor al mes",
    volume: "providerVolume",
  },
];
