import { addPoolDocuments } from "@/actions/listings";
import { SubmitButton } from "@/components/submit-button";
import { docLabel } from "@/lib/labels";
import { SELLER_DOC_TYPES } from "@/lib/room-files";

// A pool's seller or broker adds files after filing: to the whole pool, or to one loan, whose file then opens by
// that loan's rule. Bidders who saved the listing hear about new files once it is live.
export function RoomFiles({
  listingId,
  from,
  live,
  loans,
}: {
  listingId: string;
  from: "seller" | "broker";
  live: boolean;
  loans: { id: string; label: string }[];
}) {
  return (
    <form id="room-files" action={addPoolDocuments} className="mt-8 scroll-mt-6 space-y-3 border border-border p-5 rounded-xl">
      <p className="eyebrow">Add files</p>
      <p className="text-sm text-muted-foreground">
        {live
          ? "New files go into the data room now, and bidders who saved this pool are told. The desk is told too."
          : "Files go to the desk with the pool, and into the data room once it is live."}
      </p>
      <input type="hidden" name="listingId" value={listingId} />
      <input type="hidden" name="from" value={from} />
      <label className="block">
        <span className="text-[13px] text-muted-foreground">Files</span>
        <input name="documents" type="file" multiple required className="desk-input mt-2" />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="text-[13px] text-muted-foreground">What they are</span>
          <select name="documentType" defaultValue="OTHER" className="desk-input mt-2">
            {SELLER_DOC_TYPES.map((type) => (
              <option key={type} value={type}>{docLabel(type)}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-[13px] text-muted-foreground">For</span>
          <select name="noteId" defaultValue="" className="desk-input mt-2">
            <option value="">The whole pool</option>
            {loans.map((loan) => (
              <option key={loan.id} value={loan.id}>{loan.label}</option>
            ))}
          </select>
        </label>
      </div>
      <p className="text-xs text-muted-foreground">A loan&apos;s own file opens only with that loan&apos;s street and borrower. A loan tape goes on the whole pool.</p>
      <SubmitButton className="h-10 text-[13px] font-medium" pendingLabel="Uploading…">Add to the data room</SubmitButton>
    </form>
  );
}
