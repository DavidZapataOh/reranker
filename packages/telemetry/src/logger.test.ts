import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resetAppEnv } from "@reranker/env";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

const after = vi.hoisted(() => ({ tasks: [] as (() => Promise<void>)[] }));
vi.mock("./after", () => ({
  runAfter: (fn: () => Promise<void>) => {
    after.tasks.push(fn);
  },
}));

const { getLoggerProvider, log, registerLogger, requestIdFrom, resetLogger } = await import(
  "./logger"
);

type OtlpValue = { stringValue?: string; intValue?: string | number; boolValue?: boolean };
type OtlpAttribute = { key: string; value: OtlpValue };
type OtlpRecord = {
  body: { stringValue: string };
  severityText: string;
  attributes: OtlpAttribute[];
};
type OtlpBody = {
  resourceLogs: {
    resource: { attributes: OtlpAttribute[] };
    scopeLogs: { logRecords: OtlpRecord[] }[];
  }[];
};

let bodies: OtlpBody[] = [];
let headers: IncomingHttpHeaders[] = [];
let status = 200;
let receiver: Server;
let host = "";

function records(): OtlpRecord[] {
  return bodies.flatMap((body) =>
    body.resourceLogs.flatMap((resource) =>
      resource.scopeLogs.flatMap((scope) => scope.logRecords),
    ),
  );
}

function read(attributes: OtlpAttribute[], key: string): unknown {
  const value = attributes.find((attribute) => attribute.key === key)?.value;
  return value?.stringValue ?? value?.intValue ?? value?.boolValue;
}

function resourceAttr(key: string): unknown {
  return read(bodies[0]?.resourceLogs[0]?.resource.attributes ?? [], key);
}

function bodiesOf(): (string | undefined)[] {
  return records().map((record) => record.body.stringValue);
}

async function flush(): Promise<void> {
  await getLoggerProvider()?.forceFlush();
}

// A real local receiver: the exporter speaks node:http, which the MSW setup does not intercept.
beforeAll(async () => {
  receiver = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      headers.push(request.headers);
      bodies.push(JSON.parse(Buffer.concat(chunks).toString()) as OtlpBody);
      response.writeHead(status, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  host = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => receiver.close(resolve));
});

beforeEach(() => {
  bodies = [];
  headers = [];
  status = 200;
  after.tasks.length = 0;
  vi.stubEnv("APP_ENV", "preview");
  vi.stubEnv("POSTHOG_PROJECT_TOKEN", "phc_test");
  vi.stubEnv("POSTHOG_HOST", host);
  vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "abc1234");
  for (const method of ["debug", "info", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation(() => {});
  }
});

afterEach(async () => {
  await getLoggerProvider()?.shutdown();
  resetLogger();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetAppEnv();
});

describe("log", () => {
  test("exports resource and request_id attributes", async () => {
    log.info("probe", { request_id: "gru1::abc" });
    await flush();
    expect(resourceAttr("service.name")).toBe("web");
    expect(resourceAttr("deployment.environment")).toBe("preview");
    expect(resourceAttr("service.version")).toBe("abc1234");
    const [record] = records();
    expect(record?.body.stringValue).toBe("probe");
    expect(record?.severityText).toBe("info");
    expect(read(record?.attributes ?? [], "request_id")).toBe("gru1::abc");
  });

  test("authenticates with the project token", async () => {
    log.info("probe");
    await flush();
    expect(headers[0]?.authorization).toBe("Bearer phc_test");
  });

  test("service.version falls back to dev", async () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "");
    log.info("probe");
    await flush();
    expect(resourceAttr("service.version")).toBe("dev");
  });

  test("LOG_LEVEL=warn drops info", async () => {
    vi.stubEnv("LOG_LEVEL", "warn");
    log.info("quiet");
    log.warn("loud");
    await flush();
    expect(bodiesOf()).toEqual(["loud"]);
    expect(console.info).not.toHaveBeenCalled();
  });

  test("debug is dropped by default", async () => {
    log.debug("noise");
    await flush();
    expect(records()).toEqual([]);
  });

  test("attributes and message are scrubbed", async () => {
    log.warn("failed for a@b.co", { email: "a@b.co", note: "write to c@d.io", count: 2 });
    await flush();
    const [record] = records();
    expect(record?.body.stringValue).toBe("failed for [redacted]");
    expect(read(record?.attributes ?? [], "email")).toBe("[redacted]");
    expect(read(record?.attributes ?? [], "note")).toBe("write to [redacted]");
    expect(Number(read(record?.attributes ?? [], "count"))).toBe(2);
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain("a@b.co");
  });

  test("exporter failure never throws", async () => {
    status = 500;
    expect(() => log.error("boom")).not.toThrow();
    await expect(flush()).resolves.toBeUndefined();
  });

  test("a failing flush is swallowed", async () => {
    log.info("probe");
    const provider = getLoggerProvider();
    vi.spyOn(provider as NonNullable<typeof provider>, "forceFlush").mockRejectedValue(
      new Error("flush failed"),
    );
    await Promise.all(after.tasks.splice(0).map((task) => task()));
    expect(console.error).toHaveBeenCalled();
  });

  test("schedules one flush per request", async () => {
    log.info("one", { request_id: "gru1::a" });
    log.info("two", { request_id: "gru1::a" });
    log.info("other", { request_id: "gru1::b" });
    expect(after.tasks).toHaveLength(2);
    await Promise.all(after.tasks.splice(0).map((task) => task()));
    expect(bodiesOf().sort()).toEqual(["one", "other", "two"]);
    log.info("again", { request_id: "gru1::a" });
    expect(after.tasks).toHaveLength(1);
  });

  test("development writes to the console only", () => {
    vi.stubEnv("APP_ENV", "development");
    vi.stubEnv("POSTHOG_PROJECT_TOKEN", "");
    log.info("local");
    expect(getLoggerProvider()).toBeUndefined();
    expect(after.tasks).toHaveLength(0);
    expect(console.info).toHaveBeenCalledWith("local", {});
    expect(bodies).toEqual([]);
  });

  test("an invalid environment still logs to the console", () => {
    vi.stubEnv("APP_ENV", "production");
    vi.stubEnv("POSTHOG_PROJECT_TOKEN", "");
    expect(() => log.error("degraded")).not.toThrow();
    expect(console.error).toHaveBeenCalledWith("degraded", {});
  });
});

describe("registerLogger", () => {
  test("installs the provider as the global logger provider", async () => {
    const { logs } = await import("@opentelemetry/api");
    logs.disable();
    registerLogger();
    logs.getLogger("lib").emit({ body: "from a library" });
    await flush();
    expect(bodiesOf()).toEqual(["from a library"]);
    logs.disable();
  });

  test("does nothing without a provider", () => {
    vi.stubEnv("APP_ENV", "development");
    expect(() => registerLogger()).not.toThrow();
  });
});

describe("requestIdFrom", () => {
  test("reads x-vercel-id", () => {
    expect(requestIdFrom(new Headers({ "x-vercel-id": "gru1::z" }))).toBe("gru1::z");
  });

  test("falls back to local", () => {
    expect(requestIdFrom(new Headers())).toBe("local");
  });
});
