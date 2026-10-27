import Link from "next/link";
import { notFound } from "next/navigation";
import { allowPartialGroup, bidPartial, dissolveGroup, dropSeat, extendGroup, joinGroup, reconfirmSeat } from "@/actions/group";
import { FillBar } from "@/components/fill-bar";
import { Notice } from "@/components/notice";
import { SubmitButton } from "@/components/submit-button";
import { requireUser } from "@/lib/auth";
import { money, prettyDate, q } from "@/lib/format";
import { fillState, positionEconomics, seatName } from "@/lib/group-buy";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Group buy" };

export default async function GroupPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const query = await searchParams;
  const group = await prisma.groupBuy.findUnique({
    where: { id },
    include: {
      listing: { include: { notes: true, seller: true } },
      positions: { include: { user: true }, orderBy: { seat: "asc" } },
    },
  });
  if (!group) notFound();
  const target = Number(group.targetAmount);
  const seats = group.positions.map((seat) => ({ amount: Number(seat.amount), status: seat.status, slice: seat.slice }));
  const state = fillState(target, seats);
  const notes = group.listing.notes;
  const upb = notes.reduce((sum, note) => sum + Number(note.upb), 0);
  const monthly = notes.reduce((sum, note) => sum + Number(note.monthlyPi), 0);
  const rate = upb > 0 ? notes.reduce((sum, note) => sum + Number(note.interestRate) * Number(note.upb), 0) / upb : 0;
  const seniorCapital = group.positions.filter((seat) => seat.slice === "SENIOR" && seat.status !== "DROPPED").reduce((sum, seat) => sum + Number(seat.amount), 0);
  const juniorCapital = group.positions.filter((seat) => seat.slice === "JUNIOR" && seat.status !== "DROPPED").reduce((sum, seat) => sum + Number(seat.amount), 0);
  const mine = group.positions.find((seat) => seat.userId === user.id && seat.status !== "DROPPED");
  const expired = group.deadline.getTime() < Date.now() && group.status === "GATHERING" && !state.complete;
  const canManage = user.role === "ADMIN" || user.id === group.openedById;
  const economics = mine
    ? positionEconomics({
        structure: group.structure,
        price: target,
        upb,
        annualRate: rate,
        monthlyPi: monthly,
        termMonths: 360,
        amount: Number(mine.amount),
        slice: mine.slice,
        seniorYield: Number(group.seniorYield || 0),
        seniorCapital: seniorCapital || target / 2,
        juniorCapital: juniorCapital || target / 2,
      })
    : null;
  return (
    <div>
      <Link href={`/marketplace/${group.listingId}`} className="text-[13px] font-medium text-link">{group.listing.title}</Link>
      <Notice notice={q(query, "notice")} error={q(query, "error")} />
      <p className="eyebrow mt-4">Group buy · {group.status.toLowerCase()}</p>
      <h1 className="mt-3 font-semibold tracking-tight text-[28px] text-foreground">{money(target)}</h1>
      <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
        Minimum seat {money(Number(group.minPosition))}. Deadline {prettyDate(group.deadline)}.
        {group.structure === "SENIOR_JUNIOR" ? ` Senior is paid first at ${Number(group.seniorYield)}%. Junior takes the rest.` : " Every seat owns its percentage of principal and payment."}
        {group.allowPartial ? " The seller will look at a partial fill." : ""}
      </p>
      <div className="mt-8 max-w-xl">
        <FillBar filled={state.filled} target={target} />
      </div>
      <ul className="mt-8 divide-y divide-border border border-border rounded-xl">
        {group.positions.filter((seat) => seat.status !== "DROPPED").map((seat) => (
          <li key={seat.id} className="flex flex-wrap items-baseline justify-between gap-3 px-5 py-4">
            <div>
              <p className="font-semibold tracking-tight text-2xl text-foreground">{seatName({ seat: seat.seat, userId: seat.userId, name: seat.user.name, viewerId: user.id, viewerRole: user.role })}</p>
              <p className="text-sm text-muted-foreground">
                {money(Number(seat.amount))} · {Number(seat.percent).toFixed(1)}% · {seat.slice === "PARI" ? "pro rata" : seat.slice.toLowerCase()} · {seat.status === "RECONFIRM" ? "needs a reconfirm" : seat.status.toLowerCase()}
              </p>
            </div>
            {seat.userId === user.id && seat.status === "RECONFIRM" && (
              <form action={reconfirmSeat}>
                <input type="hidden" name="groupId" value={group.id} />
                <SubmitButton className="h-10 text-[13px] font-medium">Reconfirm</SubmitButton>
              </form>
            )}
            {seat.userId === user.id && (group.status === "GATHERING" || group.status === "COUNTERED" || group.status === "OFFERED") && (
              <form action={dropSeat}>
                <input type="hidden" name="groupId" value={group.id} />
                <SubmitButton variant="ghost" className="h-10 text-[13px] font-medium">Drop out</SubmitButton>
              </form>
            )}
          </li>
        ))}
        {state.remaining > 0.5 && <li className="px-5 py-4 text-sm text-muted-foreground">{money(state.remaining)} is still open.</li>}
      </ul>

      {economics && (
        <section className="mt-8 glass p-6">
          <p className="eyebrow">Your position</p>
          <p className="mt-3 text-sm text-muted-foreground">
            About {money(economics.monthly)} a month
            {economics.yieldPct != null ? ` · cash yield ${economics.yieldPct.toFixed(1)}%` : ""}
            {economics.irrPct != null ? ` · IRR ${economics.irrPct.toFixed(1)}%` : ""}
            . The IRR assumes the note’s stated payment for 360 months.
          </p>
        </section>
      )}

      {(group.status === "GATHERING" || group.status === "COUNTERED") && state.remaining > 0.5 && !mine && (
        <form action={joinGroup} className="mt-8 grid max-w-xl gap-3 border border-border p-5 rounded-xl">
          <p className="eyebrow">Take a seat</p>
          <input type="hidden" name="groupId" value={group.id} />
          <input name="amount" className="desk-input" aria-label="Seat amount" placeholder="Dollars" />
          <input name="percent" className="desk-input" aria-label="Seat percent" placeholder="Or percent of the price" />
          {group.structure === "SENIOR_JUNIOR" && (
            <select name="slice" className="desk-input" aria-label="Slice">
              <option value="SENIOR">Senior, paid first</option>
              <option value="JUNIOR">Junior, the remainder</option>
            </select>
          )}
          <SubmitButton className="h-11 text-[13px] font-medium">Join</SubmitButton>
        </form>
      )}

      {expired && canManage && (
        <section className="mt-8 grid gap-4 border border-link/30 p-5 md:grid-cols-3 rounded-xl">
          <form action={extendGroup} className="space-y-3">
            <p className="eyebrow">Extend</p>
            <input type="hidden" name="groupId" value={group.id} />
            <input name="deadline" type="datetime-local" className="desk-input" aria-label="New deadline" required />
            <SubmitButton variant="outline" className="h-10 text-[13px] font-medium">Move the deadline</SubmitButton>
          </form>
          <form action={bidPartial} className="space-y-3">
            <p className="eyebrow">Partial bid</p>
            <input type="hidden" name="groupId" value={group.id} />
            <p className="text-sm text-muted-foreground">{group.allowPartial ? `Send ${money(state.filled)} as the offer.` : "The seller has to allow a short fill first."}</p>
            <SubmitButton variant="outline" className="h-10 text-[13px] font-medium">Bid what is filled</SubmitButton>
          </form>
          <form action={dissolveGroup} className="space-y-3">
            <p className="eyebrow">Dissolve</p>
            <input type="hidden" name="groupId" value={group.id} />
            <p className="text-sm text-muted-foreground">Everyone with a seat gets a note, and the offer comes off the table.</p>
            <SubmitButton variant="ghost" className="h-10 text-[13px] font-medium">Dissolve</SubmitButton>
          </form>
        </section>
      )}

      {(user.role === "ADMIN" || user.id === group.listing.sellerId) && group.status === "GATHERING" && (
        <form action={allowPartialGroup} className="mt-6 flex items-center gap-3 text-sm text-foreground">
          <input type="hidden" name="groupId" value={group.id} />
          <input type="checkbox" name="allowPartial" value="on" defaultChecked={group.allowPartial} />
          <span>Allow a partial bid if the deadline passes short</span>
          <SubmitButton variant="outline" className="h-9 text-[13px] font-medium">Save</SubmitButton>
        </form>
      )}
    </div>
  );
}
