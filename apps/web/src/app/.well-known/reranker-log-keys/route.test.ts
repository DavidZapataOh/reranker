import { LOG_ORIGIN } from "@reranker/verify/format";
import { noteKeyId, TRUSTED_KEYS } from "@reranker/verify/trust";
import { expect, test } from "vitest";
import { GET } from "./route";

test("each production log key is served as a signed-note verifier key named after the origin", async () => {
  const response = GET();
  expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  const lines = (await response.text()).split("\n").filter(Boolean);
  const logKeys = TRUSTED_KEYS.filter((k) => k.purpose === "log");

  expect(logKeys.length).toBeGreaterThan(0);
  expect(lines).toHaveLength(logKeys.length);
  for (const [i, line] of lines.entries()) {
    // The base64 key may itself contain "+", so only the first two separate fields.
    const [, name, keyId, encoded] = /^([^+]+)\+([0-9a-f]{8})\+(.+)$/.exec(line) ?? [];
    const publicKey = Buffer.from(logKeys[i]?.publicKey ?? "", "base64");
    expect(name).toBe(LOG_ORIGIN);
    expect(keyId).toBe(Buffer.from(noteKeyId(LOG_ORIGIN, publicKey)).toString("hex"));
    expect(Buffer.from(encoded ?? "", "base64")).toEqual(
      Buffer.concat([Buffer.of(0x01), publicKey]),
    );
  }
});
