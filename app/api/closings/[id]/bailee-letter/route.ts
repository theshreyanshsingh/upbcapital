import { getApiUser } from "@/lib/auth";
import { baileeLetter } from "@/lib/custody";

export const runtime = "nodejs";

// The bailee letter the collateral file ships under, dated the day it was issued, for the parties and the desk.
// Issuing it is a form on the closing page (actions/custody.ts); this only draws it.
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const user = await getApiUser();
  if (!user) return new Response("Sign in required.", { status: 401 });
  const letter = await baileeLetter(id, user);
  if (letter.status !== 200) return new Response(letter.error, { status: letter.status });
  return new Response(Buffer.from(letter.pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="bailee-letter-${id.replace(/[^A-Za-z0-9_-]/g, "")}.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
}
