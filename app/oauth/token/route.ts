import { consumeRateLimit } from "@/lib/rate-limit";
import { clientAddress } from "@/lib/request-meta";
import { basicClientId, oauthJson, oauthPreflight, originOf, readOAuthForm, TOKEN_LIMIT, tokenRequest, tooMany } from "@/lib/oauth";

export const runtime = "nodejs";

// RFC 6749's token endpoint: a code and its PKCE verifier, or a refresh token, for an hour's access token (lib/oauth.ts).
export async function POST(request: Request) {
  const ip = clientAddress(request.headers.get("x-forwarded-for"), request.headers.get("x-real-ip"));
  if (!(await consumeRateLimit(`oauth-token:${ip}`, TOKEN_LIMIT.requests, TOKEN_LIMIT.windowMs))) return tooMany(TOKEN_LIMIT.windowMs);
  const basic = basicClientId(request.headers.get("authorization"));
  const answer = await tokenRequest(await readOAuthForm(request), originOf(request), basic);
  // RFC 6749 asks for the challenge only when the client sent its id in the Authorization header.
  return oauthJson(answer.body, answer.status, answer.status === 401 && basic ? { "WWW-Authenticate": 'Basic realm="upb-capital"' } : {});
}

export function OPTIONS() {
  return oauthPreflight();
}
