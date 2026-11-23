// What middleware.ts decides before a request reaches a page. Plain functions, so they run on the edge and in tests.

// The signed-in sections. Their pattern is the one Next built from the matcher middleware had before it also took
// redirects ("/admin/:path*" and the rest): the section alone or any path under it, a /_next/data/<build> prefix,
// a .json, .rsc or segment-prefetch suffix, and one trailing "/", "#" or "?". Next tests the path as sent and decoded,
// so this does too. The session check therefore covers exactly the paths it did.
export const DESK_SECTIONS = ["marketplace", "seller", "buyer", "broker", "admin", "closings", "notifications", "account", "inbox", "groups"] as const;

const DESK_PATH = new RegExp(
  `^(?:\\/(_next\\/data\\/[^/]{1,}))?\\/(?:${DESK_SECTIONS.join("|")})(?:\\/((?:[^\\/#\\?]+?)(?:\\/(?:[^\\/#\\?]+?))*))?(\\.json|\\.rsc|\\.segments\\/.+\\.segment\\.rsc)?[\\/#\\?]?$`,
);

export function deskPath(pathname: string) {
  if (DESK_PATH.test(pathname)) return true;
  try {
    return DESK_PATH.test(decodeURIComponent(pathname));
  } catch {
    return false;
  }
}

// Build files and icons are never redirected. The middleware matcher skips them too.
const KEEP_AS_IS = /^\/(?:_next\/static|_next\/image|favicon\.ico|icon|apple-icon)/;

// A host name as sent in the Host header, without its port. Anything that isn't a plain name is refused.
function hostName(host: string | null | undefined) {
  const name = (host || "").trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(name) ? name : "";
}

// Names a proxy may put in the Host header instead of the public one. The site's own address stands in for them.
function internalName(name: string) {
  return !name || name === "localhost" || name.endsWith(".localhost") || /^\d{1,3}(\.\d{1,3}){3}$/.test(name);
}

// Cloudflare names the scheme the visitor used in cf-visitor, as JSON: {"scheme":"http"}. x-forwarded-proto is not
// read: a proxy between Cloudflare and the app may set it to http on every request, which would loop.
export function visitorScheme(cfVisitor: string | null | undefined) {
  if (!cfVisitor) return null;
  try {
    const parsed = JSON.parse(cfVisitor) as { scheme?: unknown };
    return typeof parsed?.scheme === "string" ? parsed.scheme.toLowerCase() : null;
  } catch {
    return null;
  }
}

// Where a request should go instead, or null to serve it. A www. host goes to the bare host over https, and a visitor
// who came to Cloudflare over plain http goes to the same host over https. Both keep the path and query, and both use
// 308 so a form post is sent again as a post. A request without cf-visitor, from this machine or straight to the
// server, is left alone unless its host starts with www.
export function canonicalRedirect(input: {
  pathname: string;
  search: string;
  host: string | null | undefined;
  cfVisitor: string | null | undefined;
  appUrl?: string;
}): string | null {
  if (KEEP_AS_IS.test(input.pathname)) return null;
  const path = `${input.pathname}${input.search}`;
  const name = hostName(input.host);
  if (name.startsWith("www.") && name.length > 4) return `https://${name.slice(4)}${path}`;
  if (visitorScheme(input.cfVisitor) !== "http") return null;
  if (!internalName(name)) return `https://${name}${path}`;
  // A proxy that replaced the Host header: the site's own https address names the host, when it has one.
  const own = (input.appUrl || "").trim();
  if (!/^https:\/\//i.test(own)) return null;
  let ownName = "";
  try {
    ownName = hostName(new URL(own).host);
  } catch {
    return null;
  }
  return ownName && !internalName(ownName) ? `https://${ownName.replace(/^www\./, "")}${path}` : null;
}
