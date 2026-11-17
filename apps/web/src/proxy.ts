import { COOKIE_PREFIX } from "@reranker/auth/cookies";
import { getSessionCookie } from "better-auth/cookies";
import { type NextRequest, NextResponse } from "next/server";
import { currencyForCountry } from "./lib/pricing";
import { safeReturnPath } from "./lib/return-path";

// Each currency has its own prerendered home, so choosing one at the edge keeps the page
// static and cached, with no client-side price swap.
function rewriteHome(request: NextRequest) {
  const currency = currencyForCountry(request.headers.get("x-vercel-ip-country"));
  const url = request.nextUrl.clone();
  url.pathname = `/home/${currency}`;
  return NextResponse.rewrite(url);
}

// Only checks that a session cookie exists, which spares a database call on every navigation;
// each /app page still validates the session before showing anything.
function requireSessionCookie(request: NextRequest) {
  if (getSessionCookie(request, { cookiePrefix: COOKIE_PREFIX })) return undefined;
  const { pathname, search } = request.nextUrl;
  const url = new URL("/ingresar", request.url);
  url.searchParams.set("volver", safeReturnPath(pathname + search));
  return NextResponse.redirect(url);
}

export function proxy(request: NextRequest) {
  if (request.nextUrl.pathname === "/") return rewriteHome(request);
  return requireSessionCookie(request);
}

export const config = {
  matcher: ["/", "/app/:path*"],
};
