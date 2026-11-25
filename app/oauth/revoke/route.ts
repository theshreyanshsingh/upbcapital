import { consumeRateLimit } from "@/lib/rate-limit";
import { clientAddress } from "@/lib/request-meta";
import { basicClientId, oauthPreflight, CORS_HEADERS, readOAuthForm, REVOKE_LIMIT, revokeToken, tooMany } from "@/lib/oauth";

export const runtime = "nodejs";

// RFC 7009: an app gives up a refresh token or an access token. The answer is 200 whether or not the token was live,
// so it says nothing about tokens the caller doesn't hold (lib/oauth.ts).
export async function POST(request: Request) {
  const ip = clientAddress(request.headers.get("x-forwarded-for"), request.headers.get("x-real-ip"));
  if (!(await consumeRateLimit(`oauth-revoke:${ip}`, REVOKE_LIMIT.requests, REVOKE_LIMIT.windowMs))) return tooMany(REVOKE_LIMIT.windowMs);
  await revokeToken(await readOAuthForm(request), basicClientId(request.headers.get("authorization")));
  return new Response(null, { status: 200, headers: { ...CORS_HEADERS, "Cache-Control": "no-store" } });
}

export function OPTIONS() {
  return oauthPreflight();
}
