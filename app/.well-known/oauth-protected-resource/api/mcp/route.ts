import { metadataResponse, oauthPreflight, originOf, protectedResourceMetadata } from "@/lib/oauth";

export const dynamic = "force-dynamic";

// The same document at RFC 9728's path for the resource /api/mcp, where a client looks when the 401 names none.
export function GET(request: Request) {
  return metadataResponse(protectedResourceMetadata(originOf(request)));
}

export function OPTIONS() {
  return oauthPreflight();
}
