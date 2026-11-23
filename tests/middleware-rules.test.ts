import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import * as pageStaticInfo from "next/dist/build/analysis/get-page-static-info";
import { getMiddlewareRouteMatcher } from "next/dist/shared/lib/router/utils/middleware-route-matcher";
import { config, middleware } from "../middleware";
import { canonicalRedirect, DESK_SECTIONS, deskPath, visitorScheme } from "../lib/middleware-rules";

const HTTP = '{"scheme":"http"}';
const HTTPS = '{"scheme":"https"}';

// The matcher middleware.ts had before the redirects, compiled the way Next compiles it. Next's types leave the
// compiler out, though the module exports it.
const OLD_MATCHER = ["/marketplace/:path*", "/seller/:path*", "/buyer/:path*", "/broker/:path*", "/admin/:path*", "/closings/:path*", "/notifications/:path*", "/account/:path*", "/inbox/:path*", "/groups/:path*"];
type Matchers = Parameters<typeof getMiddlewareRouteMatcher>[0];
const { getMiddlewareMatchers } = pageStaticInfo as unknown as { getMiddlewareMatchers: (matcher: never, nextConfig: never) => unknown };
const compile = (matcher: unknown) => getMiddlewareRouteMatcher(getMiddlewareMatchers(matcher as never, {} as never) as Matchers);
const oldMatch = compile(OLD_MATCHER);
const newMatch = compile(config.matcher);
const request = (headers: Record<string, string> = {}) => ({ headers: { host: "upbcapital.com", ...headers } }) as never;
// Next tries a path as sent and then decoded (resolve-routes.ts), so these do too.
type Match = ReturnType<typeof compile>;
function runs(match: Match, path: string, req = request()) {
  if (match(path, req, {})) return true;
  try {
    return match(decodeURIComponent(path), req, {});
  } catch {
    return false;
  }
}

const PATHS = [
  "/", "/login", "/signup", "/open/abc", "/api/v1/tapes", "/api/mcp", "/sell", "/buying", "/brokers/abc", "/groupsx", "/admins",
  "/marketplace", "/marketplace/", "/marketplace/abc", "/marketplace/abc/def", "/marketplace.rsc", "/marketplace/abc.json",
  "/admin", "/admin/settings", "/admin/listings/123/pipeline", "/admin/x.segments/a.segment.rsc", "/ADMIN", "/Admin/settings",
  "/seller/verification", "/buyer/pending", "/broker", "/closings/abc", "/notifications", "/account/security", "/inbox/1", "/groups/g1",
  "/_next/data/build123/admin/settings.json", "/_next/data/build123/open.json", "/%61dmin", "/admin%2Fsettings", "/seller%ZZ",
];

test("the session check covers exactly the paths the old matcher sent to middleware", () => {
  for (const path of PATHS) assert.equal(deskPath(path), runs(oldMatch, path), path);
  for (const section of DESK_SECTIONS) assert.ok(OLD_MATCHER.includes(`/${section}/:path*`), section);
});

test("middleware runs for the signed-in sections as before, and elsewhere only for http visitors or a www. host", () => {
  for (const path of PATHS) {
    // Ordinary https traffic: exactly as before, so uploads to other paths never pass through middleware.
    assert.equal(runs(newMatch, path), runs(oldMatch, path), `no cf-visitor ${path}`);
    assert.equal(runs(newMatch, path, request({ "cf-visitor": HTTPS })), runs(oldMatch, path), `https ${path}`);
  }
  for (const path of ["/", "/login", "/api/v1/tapes", "/open/abc", "/admin", "/robots.txt", "/sitemap.xml"]) {
    assert.equal(runs(newMatch, path, request({ "cf-visitor": HTTP })), true, `http ${path}`);
    assert.equal(runs(newMatch, path, request({ host: "www.upbcapital.com" })), true, `www ${path}`);
  }
  for (const path of ["/_next/static/chunks/main.js", "/_next/static/css/876bd18aa4c4d55b.css", "/_next/image", "/favicon.ico", "/icon", "/apple-icon", "/icons/mark"]) {
    assert.equal(runs(newMatch, path, request({ "cf-visitor": HTTP })), false, `http ${path}`);
    assert.equal(runs(newMatch, path, request({ host: "www.upbcapital.com" })), false, `www ${path}`);
  }
});

test("a visitor who reached Cloudflare over http goes to https on the same host, path and query", () => {
  const go = (pathname: string, search: string, host: string | null, cfVisitor: string | null, appUrl?: string) => canonicalRedirect({ pathname, search, host, cfVisitor, appUrl });
  assert.equal(go("/", "", "upbcapital.com", HTTP), "https://upbcapital.com/");
  assert.equal(go("/open/abc", "?state=FL&lien=1", "upbcapital.com", HTTP), "https://upbcapital.com/open/abc?state=FL&lien=1");
  assert.equal(go("/admin", "", "UpbCapital.com:80", '{ "scheme" : "http" }'), "https://upbcapital.com/admin");
  assert.equal(go("/", "", "upbcapital.com", HTTPS), null);
  assert.equal(go("/", "", "upbcapital.com", null), null, "no cf-visitor: local or direct, untouched");
  assert.equal(go("/", "", "127.0.0.1:3009", null), null);
  assert.equal(go("/", "", "upbcapital.com", "not json"), null);
  assert.equal(go("/", "", "upbcapital.com", '{"scheme":"ws"}'), null);
  for (const path of ["/_next/static/css/a.css", "/_next/image", "/favicon.ico", "/icon", "/apple-icon"]) assert.equal(go(path, "", "upbcapital.com", HTTP), null, path);
  // A proxy that sends its own address as the host: the site's https address names it, or nothing happens.
  assert.equal(go("/login", "?next=%2Fadmin", "127.0.0.1:3009", HTTP, "https://upbcapital.com"), "https://upbcapital.com/login?next=%2Fadmin");
  assert.equal(go("/", "", "localhost:3009", HTTP, "https://www.upbcapital.com"), "https://upbcapital.com/");
  assert.equal(go("/", "", "127.0.0.1:3009", HTTP, "http://upbcapital.com"), null);
  assert.equal(go("/", "", "127.0.0.1:3009", HTTP, ""), null);
  assert.equal(go("/", "", "evil.com/x", HTTP), null, "a host that isn't a plain name is not echoed");
  assert.equal(visitorScheme(HTTP), "http");
  assert.equal(visitorScheme(undefined), null);
});

test("any www. host goes to the bare host over https", () => {
  const go = (pathname: string, search: string, host: string, cfVisitor: string | null = null) => canonicalRedirect({ pathname, search, host, cfVisitor });
  assert.equal(go("/", "", "www.upbcapital.com"), "https://upbcapital.com/");
  assert.equal(go("/marketplace/abc", "?tab=tape", "www.upbcapital.com", HTTPS), "https://upbcapital.com/marketplace/abc?tab=tape");
  assert.equal(go("/login", "", "WWW.upbcapital.com:443", HTTP), "https://upbcapital.com/login");
  assert.equal(go("/_next/static/chunks/a.js", "", "www.upbcapital.com"), null);
  assert.equal(go("/", "", "www."), null);
  assert.equal(go("/", "", "wwwx.upbcapital.com"), null);
});

function call(url: string, headers: Record<string, string>) {
  return middleware(new NextRequest(url, { headers }));
}

test("middleware answers 308 for http and www., and keeps the session check on the desk", async () => {
  const http = await call("http://localhost:3009/open/abc?x=1", { host: "upbcapital.com", "cf-visitor": HTTP });
  assert.equal(http.status, 308);
  assert.equal(http.headers.get("location"), "https://upbcapital.com/open/abc?x=1");
  const www = await call("http://localhost:3009/admin?y=2", { host: "www.upbcapital.com", "cf-visitor": HTTPS });
  assert.equal(www.status, 308);
  assert.equal(www.headers.get("location"), "https://upbcapital.com/admin?y=2");
  // Proxies may say http on every request; that header is never read.
  const proxied = await call("http://localhost:3009/", { host: "upbcapital.com", "cf-visitor": HTTPS, "x-forwarded-proto": "http" });
  assert.equal(proxied.headers.get("x-middleware-next"), "1");
  // The desk without a session still goes to sign in, with the page it wanted.
  const desk = await call("http://localhost:3009/admin/settings", { host: "upbcapital.com", "cf-visitor": HTTPS });
  assert.equal(desk.status, 307);
  assert.equal(new URL(desk.headers.get("location") ?? "").pathname, "/login");
  assert.equal(new URL(desk.headers.get("location") ?? "").searchParams.get("next"), "/admin/settings");
  const local = await call("http://localhost:4317/admin", { host: "localhost:4317" });
  assert.equal(new URL(local.headers.get("location") ?? "").pathname, "/login");
});
