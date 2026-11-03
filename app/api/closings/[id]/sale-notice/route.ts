import { getApiUser } from "@/lib/auth";
import { loansInScope, type PaymentPolicy, transferDate } from "@/lib/borrower-notices";
import { prisma } from "@/lib/prisma";
import { buildSaleNoticePdf } from "@/lib/sale-notice";

export const runtime = "nodejs";

// The new owner's draft sale notice. Only the buyer side and the desk get it, since only they send it.
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const user = await getApiUser();
  if (!user) return new Response("Sign in required.", { status: 401 });
  const closing = await prisma.closing.findUnique({
    where: { id },
    include: { listing: { include: { notes: true } }, boarding: true, funders: { include: { user: true } } },
  });
  if (!closing) return new Response("Not found.", { status: 404 });
  const inquiry = closing.inquiryId ? await prisma.inquiry.findUnique({ where: { id: closing.inquiryId }, include: { buyer: true } }) : null;
  const buyerSide = user.id === inquiry?.buyerId || closing.funders.some((funder) => funder.userId === user.id);
  if (user.role !== "ADMIN" && !buyerSide) return new Response("Only the new owner and the desk can draft this notice.", { status: 403 });
  if (closing.status === "CANCELED") return new Response("This closing was canceled.", { status: 409 });
  const notes = closing.noteId ? closing.listing.notes.filter((note) => note.id === closing.noteId) : closing.listing.notes;
  const loans = loansInScope(notes, closing.loanPurpose);
  if (!loans.length) return new Response("No loan on this closing looks in scope for the sale notice.", { status: 409 });
  const owner = closing.deskBidId
    ? "UPB Capital"
    : closing.funders.length > 1
      ? `${closing.funders.map((funder) => funder.user.companyName || funder.user.name).join(" and ")}, jointly`
      : inquiry?.buyer.companyName || inquiry?.buyer.name || "[new owner]";
  const boarding = closing.boarding;
  const pdf = await buildSaleNoticePdf({
    owner,
    ownerContact: closing.ownerContact ?? "",
    transfer: transferDate(closing),
    agent: boarding ? `${boarding.servicerName}${boarding.contactEmail ? `, ${boarding.contactEmail}` : ""}\n[address and telephone number]` : "",
    recording: closing.recordingNote
      ? `The transfer of ownership is recorded at: ${closing.recordingNote}`
      : "The transfer of ownership has not yet been recorded in the public records. It may be recorded in the land records of the county where the property is located.",
    policy: (closing.paymentPolicy as PaymentPolicy | null) ?? null,
    loans: loans.map((note) => ({
      streetAddress: note.streetAddress,
      city: note.city,
      state: note.state,
      zip: note.zip,
      borrowerName: note.borrowerName,
      loanNumber: notes.length === 1 ? boarding?.loanNumber ?? "" : "",
    })),
  });
  return new Response(Buffer.from(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="sale-notice-draft-${closing.id}.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
}
