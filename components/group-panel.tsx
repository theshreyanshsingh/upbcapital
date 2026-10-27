import Link from "next/link";
import { openGroup } from "@/actions/group";
import { FillBar } from "@/components/fill-bar";
import { SubmitButton } from "@/components/submit-button";
import { fillState, seatName } from "@/lib/group-buy";
import { money } from "@/lib/format";

type SeatRow = { id: string; userId: string; seat: number; amount: number; percent: number; slice: string; status: string; name: string };

export function GroupPanel({
  listingId,
  asking,
  canStart,
  viewer,
  group,
}: {
  listingId: string;
  asking: number;
  canStart: boolean;
  viewer: { id: string; role: string };
  group: { id: string; status: string; targetAmount: number; deadline: Date; positions: SeatRow[] } | null;
}) {
  if (!group && !canStart) return null;
  const state = group ? fillState(group.targetAmount, group.positions) : null;
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
      ) : (
        <form action={openGroup} className="mt-4 grid gap-3">
          <p className="text-sm text-muted-foreground">Open a group on this note. Set the price, the smallest seat, and a deadline. Other verified buyers take the rest.</p>
          <input type="hidden" name="listingId" value={listingId} />
          <input name="targetAmount" defaultValue={Math.round(asking)} className="desk-input" aria-label="Group target price" placeholder="Target price" />
          <input name="minPosition" className="desk-input" aria-label="Minimum position" placeholder="Minimum seat" />
          <input name="deadline" type="datetime-local" className="desk-input" aria-label="Group deadline" required />
          <select name="structure" className="desk-input" aria-label="Position type">
            <option value="PRO_RATA">Pro rata ownership</option>
            <option value="SENIOR_JUNIOR">Senior and junior slices</option>
          </select>
          <input name="seniorYield" className="desk-input" aria-label="Senior yield" placeholder="Senior yield %, if sliced" />
          <label className="flex items-center gap-3 text-sm text-foreground">
            <input type="checkbox" name="allowPartial" value="on" />
            Seller may accept a partial fill
          </label>
          <input name="amount" className="desk-input" aria-label="Your opening seat" placeholder="Your seat, optional" />
          <SubmitButton className="h-11 text-[13px] font-medium">Start the group</SubmitButton>
        </form>
      )}
    </section>
  );
}
