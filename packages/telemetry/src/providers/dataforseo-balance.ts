import { defineEnv } from "@reranker/env";
import { z } from "@reranker/schema";
import { digestEnv } from "../env";
import { httpError, SourceError } from "./source-error";

// Free to call: https://docs.dataforseo.com/v3/appendix/user_data/
const USER_DATA = "https://api.dataforseo.com/v3/appendix/user_data";
const OK = 20000;

const credentials = z.object({
  DATAFORSEO_LOGIN: digestEnv.shape.DATAFORSEO_LOGIN,
  DATAFORSEO_PASSWORD: digestEnv.shape.DATAFORSEO_PASSWORD,
});

const UserData = z.object({
  status_code: z.number(),
  tasks: z
    .array(
      z.object({
        status_code: z.number(),
        result: z
          .array(z.object({ money: z.object({ balance: z.number() }) }))
          .nullable()
          .optional(),
      }),
    )
    .nullable()
    .optional(),
});

/** What is left of the prepaid DataForSEO balance, in USD. */
export async function dataforseoBalance(signal?: AbortSignal): Promise<{ balanceUsd: number }> {
  const env = defineEnv([credentials]);
  if (!env.DATAFORSEO_LOGIN || !env.DATAFORSEO_PASSWORD) {
    throw new SourceError("falta DATAFORSEO_LOGIN o DATAFORSEO_PASSWORD");
  }
  const basic = Buffer.from(`${env.DATAFORSEO_LOGIN}:${env.DATAFORSEO_PASSWORD}`).toString(
    "base64",
  );
  const response = await fetch(USER_DATA, {
    headers: { Authorization: `Basic ${basic}` },
    ...(signal && { signal }),
  });
  if (!response.ok) throw httpError(response);
  const body = UserData.parse(await response.json());
  const task = body.tasks?.[0];
  const code = task?.status_code ?? body.status_code;
  const money = task?.result?.[0]?.money;
  if (code !== OK || !money) throw new SourceError(`código DataForSEO ${code}`);
  return { balanceUsd: money.balance };
}
