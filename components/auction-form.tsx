import { setAuction } from "@/actions/desk";
import { SubmitButton } from "@/components/submit-button";

function localInput(value: Date | null) {
  if (!value) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}T${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}`;
}

export function AuctionForm({
  listingId,
  bidMode,
  deadline,
}: {
  listingId: string;
  bidMode: string;
  deadline: Date | null;
}) {
  return (
    <form action={setAuction} className="mt-6 space-y-3 border border-border p-4 rounded-xl">
      <p className="eyebrow">Bid deadline</p>
      <input type="hidden" name="listingId" value={listingId} />
      <label className="block">
        <span className="text-[13px] text-muted-foreground">Style</span>
        <select name="bidMode" defaultValue={bidMode} className="desk-input mt-2" aria-label="Bid style">
          <option value="NONE">Open — bids stay visible</option>
          <option value="SEALED">Sealed — competing bids stay hidden</option>
          <option value="BEST_AND_FINAL">Best and final — one bid</option>
        </select>
      </label>
      <label className="block">
        <span className="text-[13px] text-muted-foreground">Deadline (UTC)</span>
        <input name="bidDeadline" type="datetime-local" defaultValue={localInput(deadline)} className="desk-input mt-2" aria-label="Bid deadline" />
      </label>
      <SubmitButton className="h-10 text-[13px] font-medium">Save bid terms</SubmitButton>
    </form>
  );
}
