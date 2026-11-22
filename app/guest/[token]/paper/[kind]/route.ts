import { guestPaperDownload } from "@/lib/guest-access";

export const runtime = "nodejs";

// One of the closing's papers (the purchase agreement, assignment, allonge, lost note affidavit or deposit agreement),
// filled from the closing as the inviting side gets it, for a guest on that closing's pass (lib/guest-access.ts).
export async function GET(request: Request, context: { params: Promise<{ token: string; kind: string }> }) {
  const { token, kind } = await context.params;
  return guestPaperDownload(token, kind, request);
}
