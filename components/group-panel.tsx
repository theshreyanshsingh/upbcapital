import Link from "next/link";
import { openGroup } from "@/actions/group";
import { FillBar } from "@/components/fill-bar";
import { SubmitButton } from "@/components/submit-button";
import { ACKNOWLEDGE_FIRST } from "@/lib/eligibility";
import { fillState, seatName } from "@/lib/group-buy";
import { money } from "@/lib/format";
import { participationsOpen, TRANCHES_FORM } from "@/lib/participation";

type SeatRow = { id: string; userId: string; seat: number; amount: number; percent: number; slice: string; status: string; name: string };

export function GroupPanel({
  listingId,
  asking,
  canStart,
  viewer,
  group,
  capLine = null,
  acknowledgeFirst = false,
  notices = [],
}: {
  listingId: string;
  asking: number | null;
  canStart: boolean;
  viewer: { id: string; role: string };
  group: { id: string; status: string; targetAmount: number; deadline: Date; positions: SeatRow[] } | null;
  // The buyer's bid cap below their verified funds, which a seat stays under too (lib/bid-caps.ts capHint).
  capLine?: string | null;
  // The ROAD Act acknowledgement this buyer still owes on the listing, which comes before opening a group as before a bid.
  acknowledgeFirst?: boolean;
  // The listing's eligibility notices in brief, as a bid confirmation restates them.
  notices?: string[];
}) {
  if (!group && !canStart) return null;
  const state = group ? fillState(group.targetAmount, group.positions) : null;
  // Senior and junior slices wait on counsel while the participations freeze holds (lib/participation.ts).
  const tranches = participationsOpen();
  return (
    <section className="glass p-6">
      <p className="eyebrow">Group buy</p>
      {group && state ? (
        <>
          <p className="mt-2 text-sm text-muted-foreground">Buyers are filling one offer. Names stay with the desk.</p>
          <div className="mt-4">
            <FillBar filled={state.filled} target={group.targetAmount} />
          </div>
          <ul className="mt-4 space-y-1 text-sm text-muted-foreground">
            {group.positions.filter((seat) => seat.status !== "DROPPED").map((seat) => (
              <li key={seat.id}>
                {seatName({ seat: seat.seat, userId: seat.userId, name: seat.name, viewerId: viewer.id, viewerRole: viewer.role })}
                {" · "}
                {money(seat.amount)}
              </li>
            ))}
          </ul>
          <Link href={`/groups/${group.id}`} className="mt-4 inline-block text-[13px] font-medium text-link">Open the group</Link>
        </>
      ) : acknowledgeFirst ? (
        <p className="mt-4 text-sm leading-relaxed text-foreground">
          {ACKNOWLEDGE_FIRST}{" "}
          <a href="#eligibility" className="text-link">Read the notice</a>.
        </p>
      ) : (
        <form action={openGroup} className="mt-4 grid gap-3">
          <p className="text-sm text-muted-foreground">Open a group on this note. Set the price, the smallest seat, and a deadline. Other verified buyers take the rest.</p>
          <input type="hidden" name="listingId" value={listingId} />
          {/* The ask is a figure, so the target starts filled in only for someone who can see it. */}
          <label className="block text-xs text-muted-foreground">
            Group target price
            <input name="targetAmount" inputMode="decimal" defaultValue={asking == null ? undefined : Math.round(asking)} className="desk-input mt-1 tabular-nums" />
          </label>
          <label className="block text-xs text-muted-foreground">
            Smallest seat
            <input name="minPosition" inputMode="decimal" className="desk-input mt-1 tabular-nums" />
          </label>
          <label className="block text-xs text-muted-foreground">
            Group deadline
            <input name="deadline" type="datetime-local" className="desk-input mt-1" required />
          </label>
          <label className="block text-xs text-muted-foreground">
            Position type
            <select name="structure" className="desk-input mt-1">
              <option value="PRO_RATA">Pro rata ownership</option>
              <option value="SENIOR_JUNIOR" disabled={!tranches}>Senior and junior slices{tranches ? "" : " (waits on counsel)"}</option>
            </select>
            {!tranches && <span className="mt-1 block">{TRANCHES_FORM}</span>}
          </label>
          {tranches && (
            <label className="block text-xs text-muted-foreground">
              Senior yield %, if sliced
              <input name="seniorYield" inputMode="decimal" className="desk-input mt-1 tabular-nums" />
            </label>
          )}
          <label className="flex items-center gap-3 text-sm text-foreground">
            <input type="checkbox" name="allowPartial" value="on" />
            Seller may accept a partial fill
          </label>
          <label className="block text-xs text-muted-foreground">
            Your opening seat (optional)
            <input name="amount" inputMode="decimal" className="desk-input mt-1 tabular-nums" />
            {capLine && <span className="mt-1 block text-foreground">{capLine}</span>}
          </label>
          {notices.length > 0 && <p className="text-xs leading-relaxed text-muted-foreground">{notices.join(" ")}</p>}
          <SubmitButton className="h-11 text-[13px] font-medium">Start the group</SubmitButton>
        </form>
      )}
    </section>
  );
}
