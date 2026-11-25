import { authorizationServerMetadata, metadataResponse, oauthPreflight, originOf } from "@/lib/oauth";

export const dynamic = "force-dynamic";

// RFC 8414: the sign-in endpoints for the MCP connector (lib/oauth.ts).
export function GET(request: Request) {
  return metadataResponse(authorizationServerMetadata(originOf(request)));
}

export function OPTIONS() {
  return oauthPreflight();
}
