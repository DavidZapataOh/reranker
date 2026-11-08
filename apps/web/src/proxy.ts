import { type NextRequest, NextResponse } from "next/server";
import { currencyForCountry } from "./lib/pricing";

// Each currency has its own prerendered home, so choosing one at the edge keeps the page
// static and cached, with no client-side price swap.
export function proxy(request: NextRequest) {
  const currency = currencyForCountry(request.headers.get("x-vercel-ip-country"));
  const url = request.nextUrl.clone();
  url.pathname = `/home/${currency}`;
  return NextResponse.rewrite(url);
}

export const config = {
  matcher: "/",
};
