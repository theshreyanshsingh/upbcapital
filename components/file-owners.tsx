import { SCREEN_LABELS, needsOwners, ownerGaps, ownerLine, type OwnerView } from "@/lib/beneficial-owners";
import { prettyDate } from "@/lib/format";

// A buyer file's tax ID last four, its owners with each sanctions screen as it stands, and what is still missing, for
// the desk's buyer files page. The buyer never sees the screens.
export function FileOwners({
  owners,
  entityType,
  taxIdLast4,
  recertifyBy,
}: {
  owners: OwnerView[];
  entityType: string;
  taxIdLast4: string | null;
  // The main file's date, when it is approved. Entities have none.
  recertifyBy?: Date | null;
}) {
  const listed = needsOwners(entityType) || owners.length > 0;
  const gaps = ownerGaps(entityType, owners);
  const lapsed = recertifyBy ? recertifyBy.getTime() < Date.now() : false;
  return (
    <div className="mt-2 space-y-1 text-sm">
      <p className="text-foreground">
        {taxIdLast4 ? <>Tax ID ending <span className="tabular-nums">{taxIdLast4}</span></> : "No tax ID last four on file"}
        {recertifyBy ? <span className={lapsed ? "text-bad" : "text-muted-foreground"}>{lapsed ? ` · re-certification lapsed ${prettyDate(recertifyBy)}` : ` · current until ${prettyDate(recertifyBy)}`}</span> : null}
      </p>
      {listed && (
        <div className="rounded-lg border border-border p-3">
          <p className="text-[13px] font-medium text-foreground">Owners and control persons</p>
          {owners.length ? (
            <ul className="mt-2 divide-y divide-border">
              {owners.map((owner) => (
                <li key={owner.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
                  <div className="min-w-0">
                    <p className="text-foreground">{owner.name}</p>
                    <p className="text-xs text-muted-foreground">{ownerLine(owner)}</p>
                  </div>
                  <p
                    className={`text-[13px] font-medium ${owner.screen === "MATCH" || owner.screen === "OPEN" ? "text-bad" : owner.screen === "NOT_SCREENED" ? "text-muted-foreground" : "text-good"}`}
                    title={owner.screenedAt ? `Screened ${prettyDate(owner.screenedAt)}` : undefined}
                  >
                    {SCREEN_LABELS[owner.screen]}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-xs text-muted-foreground">None listed.</p>
          )}
          {gaps.length > 0 && <p className="mt-2 text-xs font-medium text-bad">{gaps.join(" ")}</p>}
          {owners.some((owner) => owner.screen === "OPEN" || owner.screen === "MATCH") && (
            <p className="mt-2 text-xs text-muted-foreground">Approval waits until compliance decides each open review. A confirmed match stops it.</p>
          )}
        </div>
      )}
    </div>
  );
}
