import { getApiUser } from "@/lib/auth";
import { buildInvoicePdf, canReadInvoice } from "@/lib/invoices";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

// An invoice or credit note as a PDF. Each party downloads their own; the desk downloads any. Anyone else is told it
// isn't there, so an id can't be probed.
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const user = await getApiUser();
  if (!user) return new Response("Sign in required.", { status: 401 });
  const invoice = await prisma.invoice.findUnique({ where: { id } });
  if (!invoice || !canReadInvoice(user, invoice)) return new Response("Not found.", { status: 404 });
  const [party, closing, creditOf, credits] = await Promise.all([
    prisma.user.findUnique({ where: { id: invoice.userId }, select: { name: true, companyName: true, email: true } }),
    invoice.closingId ? prisma.closing.findUnique({ where: { id: invoice.closingId }, select: { listing: { select: { title: true } } } }) : Promise.resolve(null),
    invoice.creditOfId ? prisma.invoice.findUnique({ where: { id: invoice.creditOfId } }) : Promise.resolve(null),
    invoice.kind === "CREDIT_NOTE" ? Promise.resolve([]) : prisma.invoice.findMany({ where: { creditOfId: invoice.id, kind: "CREDIT_NOTE" }, orderBy: { issuedAt: "asc" } }),
  ]);
  const pdf = await buildInvoicePdf({
    invoice,
    party: party ?? { name: "Account closed", companyName: "", email: "" },
    listingTitle: closing?.listing.title ?? null,
    creditOf,
    credits,
  });
  return new Response(Buffer.from(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${invoice.number.replace(/[^A-Za-z0-9-]/g, "")}.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
}
