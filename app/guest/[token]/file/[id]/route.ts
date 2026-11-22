import { guestClosingFileDownload } from "@/lib/guest-access";

export const runtime = "nodejs";

// A file on a closing's step, for a guest on that closing's pass (lib/guest-access.ts). Stamped with the guest's name
// and logged against the pass. No session is read or set.
export async function GET(request: Request, context: { params: Promise<{ token: string; id: string }> }) {
  const { token, id } = await context.params;
  return guestClosingFileDownload(token, id, request);
}
