import { cn } from "@/lib/utils";
import { RECORD_MIN_CLOSES, accountRecord, buyerRecordLines, sellerRecordLines, sellerTrackRecord } from "@/lib/track-record";

// An account's record on UPB in plain lines, from lib/track-record.ts. Counts of what happened, never a rating.

function Lines({ lines }: { lines: string[] }) {
  return (
    <ul className="mt-3 space-y-1 text-sm text-foreground tabular-nums">
      {lines.map((line) => <li key={line}>{line}</li>)}
    </ul>
  );
}

const BASIS = `Counted from closings on UPB. Under ${RECORD_MIN_CLOSES} closings a share shows as its counts.`;

// On a listing, beside the seller's name the page already shows. Only claims the desk or the parties decided count.
export async function SellerRecordCard({ sellerId, className }: { sellerId: string; className?: string }) {
  const record = await sellerTrackRecord(sellerId);
  return (
    <section aria-labelledby="seller-record-heading" className={cn("glass p-6", className)}>
      <p id="seller-record-heading" className="eyebrow">Seller&apos;s record on UPB</p>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">What happened on this seller&apos;s closings. {BASIS}</p>
      <Lines lines={sellerRecordLines(record, "public")} />
    </section>
  );
}

// The account's own record on its desk. A buyer who also sells sees both sides.
export async function YourRecord({ user, className }: { user: { id: string; role: string }; className?: string }) {
  const { buyer, seller, sells } = await accountRecord(user.id);
  const buys = user.role === "BUYER";
  const both = buys && sells;
  return (
    <section aria-labelledby="your-record-heading" className={cn("rounded-xl border border-border p-5", className)}>
      <p id="your-record-heading" className="eyebrow">Your record</p>
      <p className="mt-2 text-sm text-muted-foreground">
        Built only from what happened on your closings, never a rating. The other side of a deal sees the decided part of it beside your {buys ? "bids" : "listings"}. {BASIS}
      </p>
      {buys && (
        <>
          {both && <p className="mt-4 text-[13px] font-semibold text-foreground">As a buyer</p>}
          <Lines lines={buyerRecordLines(buyer, "self")} />
        </>
      )}
      {(sells || !buys) && (
        <>
          {both && <p className="mt-4 text-[13px] font-semibold text-foreground">As a seller</p>}
          <Lines lines={sellerRecordLines(seller, "self")} />
        </>
      )}
    </section>
  );
}

// The desk's view of one account, open and withdrawn claims included.
export async function DeskRecord({ userId, className }: { userId: string; className?: string }) {
  const { buyer, seller, sells } = await accountRecord(userId);
  return (
    <section aria-labelledby="desk-record-heading" className={cn("rounded-xl border border-border p-5", className)}>
      <p id="desk-record-heading" className="eyebrow">Record on UPB</p>
      <p className="mt-2 text-sm text-muted-foreground">What happened on this account&apos;s closings. Sellers see the decided part beside the account&apos;s bids. {BASIS}</p>
      {sells && <p className="mt-4 text-[13px] font-semibold text-foreground">As a buyer</p>}
      <Lines lines={buyerRecordLines(buyer, "desk")} />
      {sells && (
        <>
          <p className="mt-4 text-[13px] font-semibold text-foreground">As a seller</p>
          <Lines lines={sellerRecordLines(seller, "desk")} />
        </>
      )}
    </section>
  );
}
