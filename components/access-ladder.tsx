import Link from "next/link";
import { Check, Circle, Lock } from "lucide-react";
import { NdaDialog } from "@/components/nda-dialog";

type Rung = { title: string; open: boolean; detail: string; action?: React.ReactNode };

// What this buyer can see on the listing now, and the one step to the next rung. Each rung names its own gate,
// the same ones the page applies: Pro for figures, an approved buyer file for bids, the NDA for the room.
export function AccessLadder({
  listingId,
  listingTitle,
  pro,
  verified,
  verificationStatus,
  unlocked,
  roomClosed,
  canSign,
  closingParty,
  ndaSigned,
}: {
  listingId: string;
  listingTitle: string;
  pro: boolean;
  verified: boolean;
  verificationStatus: string | null;
  unlocked: boolean;
  roomClosed: boolean;
  // The NDA prompt shows only to a buyer whose room is neither open nor closed.
  canSign: boolean;
  closingParty: boolean;
  ndaSigned: string | null;
}) {
  const rungs: Rung[] = [
    { title: "Summary", open: true, detail: "Place, lien, performance, the seller's narrative and the desk's file checks." },
    {
      title: "Figures and the full tape",
      open: pro,
      detail: pro ? "Balances, prices, yields and the analyzer are open." : "Pro opens balances, prices, yields and the analyzer.",
      action: pro ? undefined : <Link href="/buyer/subscription?reason=access" className="text-link">See Pro</Link>,
    },
    {
      title: "Bidding",
      open: verified,
      detail: verified
        ? "Your buyer file is approved, so your bids go to the desk."
        : verificationStatus === "SUBMITTED"
          ? "Your buyer file is with the desk. Bids open once it is approved."
          : "Bids open once the desk approves your buyer file.",
      action: verified || verificationStatus === "SUBMITTED" ? undefined : <Link href="/buyer/verification" className="text-link">Submit verification</Link>,
    },
    {
      title: "Data room",
      open: unlocked,
      detail: unlocked
        ? pro || closingParty
          ? `Street, borrower and files are open${ndaSigned ? `. NDA signed ${ndaSigned}` : ""}.`
          : "Street and borrower are open. The files also need Pro."
        : roomClosed
          ? "Closed. The listing went to contract, so only the deal's buyer can open it."
          : `Sign the NDA to open the street and borrower.${pro ? "" : " The files also need Pro."}`,
      action: canSign ? <NdaDialog listingId={listingId} listingTitle={listingTitle} /> : undefined,
    },
  ];
  const next = rungs.findIndex((rung) => !rung.open);
  return (
    <section aria-labelledby="access-heading" className="mt-4 rounded-xl border border-border px-5 py-4">
      <h2 id="access-heading" className="eyebrow">What you can see</h2>
      <ol className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {rungs.map((rung, index) => (
          <li key={rung.title} aria-current={index === next ? "step" : undefined} className="flex gap-2.5">
            {rung.open ? (
              <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-good" />
            ) : index === next ? (
              <Circle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-link" />
            ) : (
              <Lock aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            )}
            <div className="min-w-0">
              <p className="text-[13px] font-semibold text-foreground">
                {rung.title}
                <span className="ml-2 text-xs font-medium text-muted-foreground">{rung.open ? "Open" : index === next ? "Next step" : "Locked"}</span>
              </p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{rung.detail}</p>
              {rung.action && <div className="mt-1.5 text-[13px] font-medium">{rung.action}</div>}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
