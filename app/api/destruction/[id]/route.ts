import { getApiUser } from "@/lib/auth";
import { destructionCertificate } from "@/lib/destruction";

export const runtime = "nodejs";

// A losing bidder's destruction certificate, for the bidder, the seller, the filing broker and the desk.
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const user = await getApiUser();
  if (!user) return new Response("Sign in required.", { status: 401 });
  const result = await destructionCertificate(id, user);
  if (result.status === 404) return new Response("Not found.", { status: 404 });
  if (result.status === 403) return new Response("The certificate is for the bidder, the seller, the broker and the desk.", { status: 403 });
  return new Response(Buffer.from(result.pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="destruction-certificate-${id.slice(-6)}.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
}
