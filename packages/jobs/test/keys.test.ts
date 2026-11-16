import { describe, expect, test } from "vitest";
import { InvalidInputError } from "../src/errors";
import { assertOpaqueKey } from "../src/keys";

describe("assertOpaqueKey", () => {
  test.each([
    "free:ip:181.49.10.2",
    "free:ip:2800:e2:1::1",
    "otp:a@b.co",
    "free:ip:::ffff:1.2.3.4",
    "181.49.10.2",
    "free:ip:fe80::1",
    "",
    "has space",
    "a".repeat(201),
  ])("rejects raw key %j", (key) => {
    expect(() => assertOpaqueKey(key)).toThrow(InvalidInputError);
  });

  test.each([
    "free:ip:3q2-7wEj0Wm",
    "free:net24:Zm9vYmFy",
    "otp:identity:abc_DEF-123",
    "a".repeat(200),
  ])("accepts hmac key %j", (key) => {
    expect(() => assertOpaqueKey(key)).not.toThrow();
  });
});
