import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { NoteWizard } from "@/components/note-wizard";
import { PageIntro } from "@/components/page-intro";
import { requireRole } from "@/lib/auth";
import { feeTerms, rateText } from "@/lib/fee-schedule";
import { wizardDraft } from "@/lib/note-watch";
import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";

export const metadata = { title: "List a watched note" };
export const dynamic = "force-dynamic";

// "List it": the note wizard, prefilled from the watched note. The wizard takes starting values on a new listing as it
// does on an edit (its `initial`, as /seller/notes/new uses for a quote lead), so the holder goes through the same
// steps, checks and ownership statement as any listing and adds the address, the ask and the documents. It files
// through the ordinary listing action, and the watch then finds the listing by its state and balance
// (lib/note-watch.ts linkWatchedListings).
export default async function ListWatchedNotePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireRole(["INDIVIDUAL_SELLER", "INSTITUTIONAL_SELLER"]);
  const { id } = await params;
  const note = /^[\w-]{1,64}$/.test(id) ? await prisma.trackedNote.findUnique({ where: { id } }) : null;
  if (!note || note.userId !== user.id) notFound();
  if (note.listingId) redirect(`/seller/listings/${note.listingId}`);
  const settings = await getSettings();
  return (
    <div>
      <Link href="/seller/watch" className="-mt-2 mb-2 inline-flex h-10 items-center text-sm text-link">All watched notes</Link>
      <PageIntro
        eyebrow="Note watch"
        title="List a watched note."
        lede={`The form starts with the figures from your watch. Add the address, your ask and the documents. At today's schedule the desk keeps ${rateText(feeTerms(null, settings), "commission")} of the accepted price. Your watch shows the listing once it's filed at this balance, so if the balance has changed, edit the watch first.`}
      />
      <p className="-mt-2 mb-6 break-words text-[15px] font-medium text-foreground">{note.label}</p>
      <NoteWizard
        mode="create"
        premiumBps={settings.buyerPremiumBps}
        commissionBps={settings.sellerCommissionBps}
        fees={feeTerms(null, settings)}
        initial={wizardDraft(note)}
      />
    </div>
  );
}
