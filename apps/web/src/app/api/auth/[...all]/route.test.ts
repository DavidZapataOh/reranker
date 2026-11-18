import { afterEach, expect, test, vi } from "vitest";

const handler = vi.hoisted(() => ({ GET: vi.fn(), POST: vi.fn() }));
vi.mock("@reranker/auth/server", () => ({ auth: {} }));
vi.mock("better-auth/next-js", () => ({ toNextJsHandler: () => handler }));

const telemetry = vi.hoisted(() => ({ captureServerEvent: vi.fn() }));
vi.mock("@reranker/telemetry", () => telemetry);

const { GET, POST } = await import("./route");

afterEach(() => {
  vi.clearAllMocks();
});

const request = (path: string, method = "POST") =>
  new Request(`https://reranker.co/api/auth${path}`, { method });

test("a request the limiter refuses emits auth_rate_limited with its route", async () => {
  handler.POST.mockResolvedValue(new Response(null, { status: 429 }));
  const sent = request("/sign-in/email-otp?x=1");
  const response = await POST(sent);
  expect(response.status).toBe(429);
  expect(telemetry.captureServerEvent).toHaveBeenCalledExactlyOnceWith(
    { name: "auth_rate_limited", props: { route: "/api/auth/sign-in/email-otp" } },
    { headers: sent.headers, subject: { system: true } },
  );
});

test("any other response passes through without an event", async () => {
  const answered = new Response("{}", { status: 200 });
  handler.POST.mockResolvedValue(answered);
  await expect(POST(request("/sign-in/email-otp"))).resolves.toBe(answered);
  expect(telemetry.captureServerEvent).not.toHaveBeenCalled();
});

test("GET is Better Auth's own handler", () => {
  expect(GET).toBe(handler.GET);
});
