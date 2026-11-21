import { type SystemTx, withSystem } from "@reranker/db";
import { captures, modelRegimes } from "@reranker/db/schema";
import {
  buildModelRegimeStatement,
  ENVELOPE_CONTENT_TYPE,
  putArtifact,
  requestLogInclusion,
  signStatement,
} from "@reranker/evidence";
import type { CaptureChannel, CaptureProvider, EngineId } from "@reranker/schema";
import { captureServerEvent, sendOpsAlert } from "@reranker/telemetry";
import type { CaptureId } from "@reranker/verify/format";
import { and, desc, eq, sql } from "drizzle-orm";

type RegimeKey = { engine: EngineId; channel: CaptureChannel; provider: CaptureProvider };
type RegimeRow = typeof modelRegimes.$inferSelect;
type Opened = { regime: RegimeRow; from: string | null; envelopeSha256: string };

// Serializes every regime decision of one engine, channel and provider, so two captures of a new
// model open one regime between them.
function lockKey(tx: SystemTx, key: RegimeKey) {
  return tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`model-regime:${key.engine}:${key.channel}:${key.provider}`}))`,
  );
}

async function latest(tx: SystemTx, key: RegimeKey): Promise<RegimeRow | undefined> {
  const [row] = await tx
    .select()
    .from(modelRegimes)
    .where(
      and(
        eq(modelRegimes.engine, key.engine),
        eq(modelRegimes.channel, key.channel),
        eq(modelRegimes.provider, key.provider),
      ),
    )
    .orderBy(desc(modelRegimes.openedAt))
    .limit(1);
  return row;
}

/** Signs a new regime, stores its envelope and queues it for the transparency log. */
async function seal({ regime, from, envelopeSha256 }: Opened): Promise<void> {
  const signed = await signStatement(
    buildModelRegimeStatement({
      regime: {
        regime_id: regime.id,
        engine: regime.engine,
        channel: regime.channel,
        vendor: regime.provider,
        from,
        to: regime.modelReported as string,
        first_capture_id: regime.firstCaptureId as CaptureId,
        opened_at: regime.openedAt.toISOString(),
      },
      firstCaptureEnvelopeSha256: envelopeSha256,
      signedAt: new Date(),
    }),
  );
  await putArtifact("envelopes", signed.envelopeBytes, { contentType: ENVELOPE_CONTENT_TYPE });
  await withSystem("model-regimes", async (tx) => {
    await tx
      .update(modelRegimes)
      .set({ envelopeSha256: Buffer.from(signed.envelopeSha256, "hex") })
      .where(eq(modelRegimes.id, regime.id));
    await requestLogInclusion(
      { ref: regime.id, kind: "regime", envelopeSha256: signed.envelopeSha256 },
      { tx },
    );
  });
}

/**
 * Keeps the model regimes current from one stored capture. The first model an engine reports
 * opens its initial regime; a different model in a capture taken at or after the current regime
 * opened opens a new one, which is signed, logged, alerted and counted once. A capture older than
 * the current regime, collected late from a queue, never opens one.
 */
export async function recordModelSeen(
  captureId: string,
): Promise<{ newRegime: boolean; regimeId: string | null }> {
  let opened: Opened | null = null;
  const regimeId = await withSystem("model-regimes", async (tx) => {
    const [capture] = await tx
      .select({
        engine: captures.engine,
        channel: captures.channel,
        provider: captures.provider,
        model: captures.modelReported,
        capturedAt: captures.capturedAt,
        envelopeSha256: captures.envelopeSha256,
      })
      .from(captures)
      .where(eq(captures.id, captureId));
    if (!capture?.model) return null;
    const { model, capturedAt } = capture;
    await lockKey(tx, capture);
    const current = await latest(tx, capture);

    if (current && current.modelReported === model) {
      await tx
        .update(modelRegimes)
        .set({
          firstSeenAt: sql`least(${modelRegimes.firstSeenAt}, ${capturedAt})`,
          lastSeenAt: sql`greatest(${modelRegimes.lastSeenAt}, ${capturedAt})`,
          captureCount: sql`${modelRegimes.captureCount} + 1`,
        })
        .where(eq(modelRegimes.id, current.id));
      return current.id;
    }
    if (current && capturedAt < current.openedAt) return null;

    const [regime] = await tx
      .insert(modelRegimes)
      .values({
        engine: capture.engine,
        channel: capture.channel,
        provider: capture.provider,
        cause: current ? "model" : "initial",
        modelReported: model,
        openedAt: capturedAt,
        firstSeenAt: capturedAt,
        lastSeenAt: capturedAt,
        captureCount: 1,
        firstCaptureId: captureId,
      })
      .returning();
    if (!regime) return null;
    if (current) {
      opened = {
        regime,
        from: current.modelReported,
        envelopeSha256: capture.envelopeSha256.toString("hex"),
      };
    }
    return regime.id;
  });

  const change = opened as Opened | null;
  if (!change) return { newRegime: false, regimeId };
  const { regime, from } = change;
  const to = regime.modelReported as string;
  await sendOpsAlert("model-change", {
    engine: regime.engine,
    channel: regime.channel,
    provider: regime.provider,
    from: from ?? "none",
    to,
  });
  captureServerEvent(
    {
      name: "regime_opened",
      props: {
        engine: regime.engine,
        channel: regime.channel,
        from,
        to,
        first_capture_id: regime.firstCaptureId as string,
      },
    },
    { subject: { system: true } },
  );
  await seal(change);
  return { newRegime: true, regimeId: regime.id };
}

/** The regime in force for an engine and channel, of one provider or the latest of any. */
export async function currentRegime(
  engine: EngineId,
  channel: CaptureChannel,
  provider?: CaptureProvider,
): Promise<{
  regimeId: string;
  modelReported: string | null;
  cause: "initial" | "model" | "drift";
  since: Date;
} | null> {
  const [row] = await withSystem(
    "model-regimes",
    (tx) =>
      tx
        .select()
        .from(modelRegimes)
        .where(
          and(
            eq(modelRegimes.engine, engine),
            eq(modelRegimes.channel, channel),
            provider === undefined ? undefined : eq(modelRegimes.provider, provider),
          ),
        )
        .orderBy(desc(modelRegimes.openedAt))
        .limit(1),
    { readOnly: true },
  );
  return row
    ? { regimeId: row.id, modelReported: row.modelReported, cause: row.cause, since: row.openedAt }
    : null;
}

/**
 * Opens a drift regime the canary detected, keeping the model in force. Opening the same one
 * twice returns the regime the first call opened.
 */
export async function openRegime(input: {
  engine: EngineId;
  channel: CaptureChannel;
  provider: CaptureProvider;
  cause: "drift";
  openedAt: Date;
  detail: Record<string, string | number>;
}): Promise<{ regimeId: string; created: boolean }> {
  return withSystem("model-regimes", async (tx) => {
    await lockKey(tx, input);
    const current = await latest(tx, input);
    const [created] = await tx
      .insert(modelRegimes)
      .values({
        engine: input.engine,
        channel: input.channel,
        provider: input.provider,
        cause: input.cause,
        modelReported: current?.modelReported ?? null,
        openedAt: input.openedAt,
        firstSeenAt: input.openedAt,
        lastSeenAt: input.openedAt,
        captureCount: 0,
        detail: input.detail,
      })
      .onConflictDoNothing()
      .returning({ id: modelRegimes.id });
    if (created) return { regimeId: created.id, created: true };
    const [existing] = await tx
      .select({ id: modelRegimes.id })
      .from(modelRegimes)
      .where(
        and(
          eq(modelRegimes.engine, input.engine),
          eq(modelRegimes.channel, input.channel),
          eq(modelRegimes.provider, input.provider),
          eq(modelRegimes.openedAt, input.openedAt),
        ),
      );
    return { regimeId: existing?.id as string, created: false };
  });
}
