import Link from "next/link";
import { MASTER_LABELS, closingMasterStatus } from "@/lib/agreements";
import { prettyDate } from "@/lib/format";

// On a closing's documents card: whether each party has signed the current master agreement, which decides whether
// the purchase agreement incorporates the masters or carries its own articles. The party viewing gets a link to sign.
export async function ClosingMasters({ closingId, viewerId }: { closingId: string; viewerId: string }) {
  const status = await closingMasterStatus(closingId);
  if (!status) return null;
  const group = status.parties.filter((party) => party.side === "BUYER").length > 1;
  return (
    <div className="mt-5 border-t border-border pt-4">
      <p className="text-[13px] font-medium text-foreground">Master agreements</p>
      <p className="mt-1 text-sm text-muted-foreground">
        {status.complete
          ? "Every party signed the current version, so the purchase agreement incorporates the masters by reference."
          : "Until every party signs the current version, the purchase agreement's own articles govern."}
      </p>
      <ul className="mt-3 divide-y divide-border border-y border-border">
        {status.parties.map((party) => (
          <li key={`${party.side}-${party.userId}`} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-2.5 text-sm">
            <span className="min-w-0 text-foreground">
              {party.side === "SELLER" ? "Seller" : group ? "Seat" : "Buyer"} · {party.name}
              <span className="block text-xs text-muted-foreground">{MASTER_LABELS[party.kind]}</span>
            </span>
            <span className="flex flex-wrap items-baseline gap-x-3 text-muted-foreground">
              {party.acceptance ? `Version ${party.acceptance.version}, signed ${prettyDate(party.acceptance.acceptedAt)}` : `Version ${party.version} not signed`}
              {!party.acceptance && party.userId === viewerId && (
                <Link href={`/account/agreements?back=${encodeURIComponent(`/closings/${closingId}`)}#${party.kind.toLowerCase()}`} className="text-[13px] font-medium text-link">
                  Read and sign
                </Link>
              )}
            </span>
          </li>
        ))}
        {status.deskPurchase && <li className="py-2.5 text-sm text-muted-foreground">UPB Capital buys for its own book, so no master purchase agreement applies.</li>}
      </ul>
    </div>
  );
}
