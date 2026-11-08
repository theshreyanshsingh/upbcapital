import Link from "next/link";
import { deskTranche, flagLine, TRANCHE_LABEL } from "@/lib/flow-programs";
import { launchTime } from "@/lib/launch-rules";

const SHOWN = 12;

// On the desk's review of a listing: the programme it is a tranche of, where its first look stands, and the loans
// outside the programme's criteria. Nothing shows for a listing outside a programme.
export async function FlowTrancheNote({ listingId }: { listingId: string }) {
  const tranche = await deskTranche(listingId);
  if (!tranche) return null;
  const stage =
    tranche.status === "FIRST_LOOK" && tranche.firstLookEndsAt
      ? `First look for committed buyers until ${launchTime(tranche.firstLookEndsAt)}.`
      : tranche.status === "FIRST_LOOK"
        ? `Approval starts its ${tranche.program.firstLookHours}-hour first look for committed buyers. The market's alerts wait for the release.`
        : `${TRANCHE_LABEL[tranche.status] ?? tranche.status}.`;
  return (
    <section aria-labelledby="tranche-heading" className="mt-4 rounded-xl border border-link/30 bg-link/5 p-4">
      <p id="tranche-heading" className="text-sm text-foreground">
        Tranche {tranche.sequence} of <Link href={`/admin/flow/${tranche.program.id}`} className="font-medium text-link">{tranche.program.name}</Link>. {stage}
      </p>
      {tranche.flags.length === 0 ? (
        <p className="mt-1 text-sm text-muted-foreground">All {tranche.loans} loans fit the programme&apos;s criteria.</p>
      ) : (
        <>
          <p className="mt-1 text-sm text-foreground">
            {tranche.flags.length} of {tranche.loans} loans sit outside the programme&apos;s criteria.
          </p>
          <ul className="mt-1 space-y-0.5 text-sm text-bad">
            {tranche.flags.slice(0, SHOWN).map((flag) => (
              <li key={flag.index}>{flagLine(flag)}</li>
            ))}
          </ul>
          {tranche.flags.length > SHOWN && <p className="mt-1 text-xs text-muted-foreground">And {tranche.flags.length - SHOWN} more.</p>}
        </>
      )}
    </section>
  );
}
