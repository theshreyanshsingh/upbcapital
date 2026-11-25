import { metadataResponse, oauthPreflight, originOf, protectedResourceMetadata } from "@/lib/oauth";

export const dynamic = "force-dynamic";

// RFC 9728: where an MCP client that got a 401 from /api/mcp finds who signs it in (lib/oauth.ts).
export function GET(request: Request) {
  return metadataResponse(protectedResourceMetadata(originOf(request)));
}

export function OPTIONS() {
  return oauthPreflight();
}
