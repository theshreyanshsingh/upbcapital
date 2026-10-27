import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { verifySession, SESSION_COOKIE } from "@/lib/session";

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
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
    role !== "ADMIN"
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

export const config = {
  matcher: ["/marketplace/:path*", "/seller/:path*", "/buyer/:path*", "/broker/:path*", "/admin/:path*", "/closings/:path*", "/notifications/:path*", "/account/:path*", "/inbox/:path*", "/groups/:path*"],
};
