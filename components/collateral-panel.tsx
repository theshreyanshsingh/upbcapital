import { FieldBadge } from "@/components/loan-file-view";
import { UsMap, type MapPin } from "@/components/us-map";
import { money } from "@/lib/format";
import type { FieldState } from "@/lib/loan-file";

type Single = {
  open: boolean;
  streetAddress: string;
  city: string;
  state: string;
  zip: string;
  borrowerName: string;
  streetState: FieldState;
  borrowerState: FieldState;
};

// Where the paper sits. A single note's street and borrower show only once the loan is open to this viewer; a
// pool says how many loans are left and whether streets are open. Pins arrive already rounded by the page.
export function CollateralPanel({
  title,
  single,
  pool,
  pins,
  estimate,
  signed,
}: {
  title: string;
  single: Single | null;
  pool: { total: number; forSale: number; unlocked: boolean } | null;
  pins: MapPin[];
  // The value estimate, for Pro only: the sum of the loans with a showable estimate.
  estimate: { total: number; count: number; of: number; provider: string } | null;
  // "Signed by … on …", once this viewer's NDA opened the room.
  signed: string | null;
}) {
  return (
    <section aria-labelledby="collateral-heading" className="mt-8 glass p-6">
      <h2 id="collateral-heading" className="eyebrow">Collateral</h2>
      {single ? (
        <>
          <p className="mt-3 font-semibold tracking-tight text-3xl text-foreground">{single.open ? single.streetAddress : "Street withheld"}</p>
          <p className="mt-2 flex flex-wrap items-center gap-2 text-muted-foreground">
            {single.city}, {single.state}{single.open && single.zip ? ` ${single.zip}` : ""}
            <FieldBadge field="streetAddress" state={single.streetState} showValue={single.open} />
          </p>
          <p className="mt-4 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            Borrower: {single.open ? single.borrowerName || "Not provided" : "Withheld until confidentiality"}
            <FieldBadge field="borrowerName" state={single.borrowerState} showValue={single.open} />
          </p>
        </>
      ) : pool ? (
        <p className="mt-3 text-sm text-muted-foreground">
          {pool.forSale === pool.total ? `${pool.total} loans.` : `${pool.forSale} of ${pool.total} loans still for sale.`} {pool.unlocked ? "Addresses are open." : "Street addresses open after confidentiality."}
        </p>
      ) : null}
      {signed && <p className="mt-4 text-sm text-muted-foreground">{signed}</p>}
      {estimate && (
        <p className="mt-4 text-sm text-muted-foreground tabular-nums">
          Value estimate {money(estimate.total)}
          {pool ? ` · ${estimate.count} of ${estimate.of} loans` : ""} · {estimate.provider}
        </p>
      )}
      <div className="mt-5">
        <UsMap label={`Map for ${title}`} pins={pins} />
      </div>
    </section>
  );
}
