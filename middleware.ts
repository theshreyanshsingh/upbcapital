import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { canonicalRedirect, deskPath } from "@/lib/middleware-rules";
import { verifySession, SESSION_COOKIE } from "@/lib/session";

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  // www. to the bare host, and plain http through Cloudflare to https (lib/middleware-rules.ts).
  const canonical = canonicalRedirect({
    pathname,
    search: request.nextUrl.search,
    host: request.headers.get("host"),
    cfVisitor: request.headers.get("cf-visitor"),
    appUrl: process.env.NEXT_PUBLIC_APP_URL,
  });
  if (canonical) return NextResponse.redirect(canonical, 308);
  // The redirect matchers reach every page. The session check stays on the signed-in sections it always covered.
  if (!deskPath(pathname)) return NextResponse.next();
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const session = token ? await verifySession(token) : null;
  if (!session) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }
  const role = session.role;
  if (pathname.startsWith("/admin") && role !== "ADMIN") {
    return NextResponse.redirect(new URL("/", request.url));
  }
  if (
    pathname.startsWith("/seller") &&
    role !== "INDIVIDUAL_SELLER" &&
    role !== "INSTITUTIONAL_SELLER" &&
    role !== "ADMIN" &&
    // A broker is the seller of record on what they file, so they keep the same seller file.
    !(role === "BROKER" && pathname === "/seller/verification")
  ) {
    return NextResponse.redirect(new URL("/", request.url));
  }
  if ((pathname.startsWith("/buyer") || pathname.startsWith("/marketplace")) && role !== "BUYER" && role !== "ADMIN") {
    return NextResponse.redirect(new URL("/", request.url));
  }
  if (pathname.startsWith("/broker") && role !== "BROKER" && role !== "ADMIN") {
    return NextResponse.redirect(new URL("/", request.url));
  }
  return NextResponse.next();
}

// The first ten are the signed-in sections, as before. The last two run middleware only for a visitor Cloudflare says
// came over plain http, or a www. host, so ordinary https traffic (and its uploads) never passes through it. Build
// files and icons are skipped. Next reads this object at build time, so it stays a literal.
export const config = {
  matcher: [
    "/marketplace/:path*",
    "/seller/:path*",
    "/buyer/:path*",
    "/broker/:path*",
    "/admin/:path*",
    "/closings/:path*",
    "/notifications/:path*",
    "/account/:path*",
    "/inbox/:path*",
    "/groups/:path*",
    {
      source: "/((?!_next/static|_next/image|favicon\\.ico|icon|apple-icon).*)",
      has: [{ type: "header", key: "cf-visitor", value: '.*"scheme"\\s*:\\s*"http".*' }],
    },
    {
      source: "/((?!_next/static|_next/image|favicon\\.ico|icon|apple-icon).*)",
      has: [{ type: "host", value: "www\\..+" }],
    },
  ],
};
