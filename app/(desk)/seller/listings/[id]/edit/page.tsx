import { notFound } from "next/navigation";
import { NoteWizard } from "@/components/note-wizard";
import { PageIntro } from "@/components/page-intro";
import { requireRole } from "@/lib/auth";
import { isoDate, num } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";

export const metadata = { title: "Edit listing" };

export default async function EditListingPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireRole(["INDIVIDUAL_SELLER", "INSTITUTIONAL_SELLER", "ADMIN"]);
  const { id } = await params;
  const listing = await prisma.listing.findUnique({ where: { id }, include: { notes: true } });
  if (!listing || listing.sellerId !== user.id || listing.kind !== "SINGLE" || !listing.notes[0]) notFound();
  if (listing.status !== "SUBMITTED" && listing.status !== "CHANGES_REQUESTED") notFound();
  const note = listing.notes[0];
  const settings = await getSettings();
  return (
    <div>
      <PageIntro eyebrow="Revise" title="Update the file." lede="Saving sends the listing back to the desk as submitted." />
      <NoteWizard
        mode="edit"
        listingId={listing.id}
        premiumBps={settings.buyerPremiumBps}
        commissionBps={settings.sellerCommissionBps}
        initial={{
          streetAddress: note.streetAddress,
          city: note.city,
          state: note.state,
          zip: note.zip,
          propertyType: note.propertyType,
          occupancy: note.occupancy,
          estimatedValue: String(num(note.estimatedValue)),
          lienPosition: note.lienPosition,
          upb: String(num(note.upb)),
          interestRate: String(num(note.interestRate)),
          monthlyPi: String(num(note.monthlyPi)),
          paymentStatus: note.paymentStatus,
          monthsDelinquent: String(note.monthsDelinquent),
          lastPaidDate: isoDate(note.lastPaidDate) ?? "",
          originationDate: isoDate(note.originationDate) ?? "",
          maturityDate: isoDate(note.maturityDate) ?? "",
          askingPrice: String(num(note.askingPrice)),
          foreclosureStatus: note.foreclosureStatus,
          borrowerName: note.borrowerName,
          narrative: listing.summary,
        }}
      />
    </div>
  );
}
