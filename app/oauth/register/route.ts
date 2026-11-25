import { consumeRateLimit } from "@/lib/rate-limit";
import { clientAddress } from "@/lib/request-meta";
import { oauthJson, oauthPreflight, readJsonBody, REGISTER_LIMIT, registerClient, tooMany } from "@/lib/oauth";

export const runtime = "nodejs";

// RFC 7591 dynamic registration, for public clients such as claude.ai's and ChatGPT's connectors (lib/oauth.ts).
// Anyone may register; the buyer's approval on /oauth/authorize is what grants anything.
export async function POST(request: Request) {
  const ip = clientAddress(request.headers.get("x-forwarded-for"), request.headers.get("x-real-ip"));
  if (!(await consumeRateLimit(`oauth-register:${ip}`, REGISTER_LIMIT.requests, REGISTER_LIMIT.windowMs))) return tooMany(REGISTER_LIMIT.windowMs);
  const answer = await registerClient(await readJsonBody(request));
  return oauthJson(answer.body, answer.status);
}

export function OPTIONS() {
  return oauthPreflight();
}
