import { GET as holdings } from "@/app/api/v1/holdings/route";
import { GET as listing } from "@/app/api/v1/listings/[id]/route";
import { GET as listings } from "@/app/api/v1/listings/route";
import { GET as matches } from "@/app/api/v1/matches/route";
import { GET as offer } from "@/app/api/v1/offers/[id]/route";
import { GET as offers } from "@/app/api/v1/offers/route";
import { mcpNotAllowed, mcpPost, type V1Routes } from "@/lib/mcp";

// The MCP connector for the buyer API (lib/mcp.ts). Each tool runs the v1 handler named here, in-process, so a tool
// call is answered, limited and logged exactly as the same GET to /api/v1 would be.
const V1: V1Routes = { listings, listing, matches, offers, offer, holdings };

export async function POST(request: Request) {
  return mcpPost(request, V1);
}

export function GET() {
  return mcpNotAllowed();
}

export function DELETE() {
  return mcpNotAllowed();
}
