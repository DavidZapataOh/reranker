import { HttpResponse, http } from "msw/http";
import { setupServer } from "msw/node";
import { delay } from "msw/utils/delay";

export const server = setupServer();

export function respondWith5xx(url: string, status: 500 | 502 | 503 | 504 = 503): void {
  server.use(http.all(url, () => new HttpResponse(null, { status })));
}

export function respondAfter(url: string, ms: number): void {
  server.use(
    http.all(url, async () => {
      await delay(ms);
      return HttpResponse.json({});
    }),
  );
}

export function respondInvalid(url: string, body: string): void {
  server.use(
    http.all(
      url,
      () =>
        new HttpResponse(body, { status: 200, headers: { "content-type": "application/json" } }),
    ),
  );
}
