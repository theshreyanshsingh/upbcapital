import Link from "next/link";
import { notFound } from "next/navigation";
import { allowPartialGroup, bidPartial, dissolveGroup, dropSeat, extendGroup, joinGroup, reconfirmSeat } from "@/actions/group";
import { FillBar } from "@/components/fill-bar";
import { Notice } from "@/components/notice";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { SubmitButton } from "@/components/submit-button";
import { requireUser } from "@/lib/auth";
import { bidCapFor, capHint } from "@/lib/bid-caps";
import {
  ACKNOWLEDGE_FIRST,
  acknowledgementMissing,
  confirmNotices,
  eligibilityFor,
  MARYLAND_HEADING,
  MARYLAND_PROMPT,
  ROAD_HEADING,
  ROAD_NOTICE,
  ROAD_RENT,
  ROAD_UNANSWERED,
  type Eligibility,
} from "@/lib/eligibility";
import { money, prettyDate, q } from "@/lib/format";
import { fillState, positionEconomics, seatName } from "@/lib/group-buy";
import { roadAcknowledgedAt } from "@/lib/inquiry";
import { trancheBlock } from "@/lib/participation";
import { prisma } from "@/lib/prisma";
import { canSeeListing } from "@/lib/private-listings";

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
  // A group on a listing hidden from this viewer isn't there for them, seat or not (lib/private-listings.ts).
  if (!(await canSeeListing(user, group.listing))) notFound();
  const target = Number(group.targetAmount);
  const seats = group.positions.map((seat) => ({ amount: Number(seat.amount), status: seat.status, slice: seat.slice }));
  const state = fillState(target, seats);
  // A seat stays under the buyer's bid cap like one bid (lib/bid-caps.ts). Shown only when one below the funds applies.
  const cap = user.role === "BUYER" ? capHint(await bidCapFor(user.id)) : null;
  const notes = group.listing.notes;
  // The eligibility screen a bid shows, on the loans this group buys: the ROAD Act notice, the 350-home
  // acknowledgement a seat waits on, and the Maryland prompt (lib/group-eligibility.ts).
  const screened = group.noteId ? notes.filter((note) => note.id === group.noteId) : notes;
  const profile = user.role === "BUYER" ? await prisma.buyerProfile.findUnique({ where: { userId: user.id } }) : null;
  const eligibility = eligibilityFor(screened, profile);
  const acknowledgedAt = user.role === "BUYER" && eligibility.acknowledge ? await roadAcknowledgedAt(user.id, group.listingId) : null;
  const acknowledgeFirst = user.role === "BUYER" && acknowledgementMissing(eligibility, acknowledgedAt, profile?.eligibilityAt);
  const notices = confirmNotices(eligibility);
  // A senior and junior group takes no new seat and sends no first offer while counsel reviews tranches.
  const paused = trancheBlock(group.structure);
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
      {paused && (group.status === "GATHERING" || group.status === "COUNTERED") && <p className="mt-3 max-w-2xl text-sm text-foreground">{paused}</p>}
      {(user.role === "BUYER" || user.role === "ADMIN") && (eligibility.road || eligibility.maryland) && (
        <GroupEligibility
          listingId={group.listingId}
          eligibility={eligibility}
          buyer={user.role === "BUYER"}
          acknowledgedAt={acknowledgedAt}
          acknowledgeFirst={acknowledgeFirst}
        />
      )}
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
                {cap && Math.round(Number(seat.amount) * 100) > cap.cents + 1 && <p className="mt-1 max-w-xs text-xs text-bad">This seat is over your cap. {cap.line}</p>}
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

      {(group.status === "GATHERING" || group.status === "COUNTERED") && state.remaining > 0.5 && !mine && !paused && acknowledgeFirst && (
        <p className="mt-8 max-w-xl text-sm leading-relaxed text-foreground">
          {ACKNOWLEDGE_FIRST}{" "}
          <Link href={`/marketplace/${group.listingId}#eligibility`} className="text-link">Read the notice</Link>.
        </p>
      )}
      {(group.status === "GATHERING" || group.status === "COUNTERED") && state.remaining > 0.5 && !mine && !paused && !acknowledgeFirst && (
        <form action={joinGroup} className="mt-8 grid max-w-xl gap-3 border border-border p-5 rounded-xl">
          <p className="eyebrow">Take a seat</p>
          <input type="hidden" name="groupId" value={group.id} />
          <input name="amount" inputMode="decimal" className="desk-input" aria-label="Seat amount" placeholder="Dollars" />
          <input name="percent" className="desk-input" aria-label="Seat percent" placeholder="Or percent of the price" />
          {cap && <p className="text-[13px] text-foreground tabular-nums">{cap.line}</p>}
          {group.structure === "SENIOR_JUNIOR" && (
            <select name="slice" className="desk-input" aria-label="Slice">
              <option value="SENIOR">Senior, paid first</option>
              <option value="JUNIOR">Junior, the remainder</option>
            </select>
          )}
          {notices.length > 0 && <p className="text-xs leading-relaxed text-muted-foreground">{notices.join(" ")}</p>}
          <SubmitButton className="h-11 text-[13px] font-medium">Join</SubmitButton>
        </form>
      )}

      {expired && canManage && (
        <section className="mt-8 grid gap-4 border border-link/30 p-5 md:grid-cols-3 rounded-xl">
          <form action={extendGroup} className="space-y-3">
            <p className="eyebrow">Extend</p>
            <input type="hidden" name="groupId" value={group.id} />
            <label className="block text-[13px] text-muted-foreground">
              New deadline
              <input name="deadline" type="datetime-local" className="desk-input mt-1" required />
            </label>
            <SubmitButton variant="outline" className="h-10 text-[13px] font-medium">Move the deadline</SubmitButton>
          </form>
          {paused ? (
            <div className="space-y-3">
              <p className="eyebrow">Partial bid</p>
              <p className="text-sm text-muted-foreground">A senior and junior group sends no offer until counsel rules on it.</p>
            </div>
          ) : (
            <form action={bidPartial} className="space-y-3">
              <p className="eyebrow">Partial bid</p>
              <input type="hidden" name="groupId" value={group.id} />
              <p className="text-sm text-muted-foreground">{group.allowPartial ? `Send ${money(state.filled)} as the offer.` : "The seller has to allow a short fill first."}</p>
              <ConfirmSubmit
                title={`Send ${money(state.filled)} as the group's offer?`}
                consequence="Every pledged seat is committed at its share of this price if the seller accepts. Seats still reconfirming aren't counted."
                confirmLabel="Send the offer"
                pendingLabel="Sending…"
                variant="outline"
                className="h-10 text-[13px] font-medium"
              >
                Bid what is filled
              </ConfirmSubmit>
            </form>
          )}
          <form action={dissolveGroup} className="space-y-3">
            <p className="eyebrow">Dissolve</p>
            <input type="hidden" name="groupId" value={group.id} />
            <p className="text-sm text-muted-foreground">Everyone with a seat gets a note, and the offer comes off the table.</p>
            <ConfirmSubmit
              title="Dissolve this group?"
              consequence="Every seat holder gets a note, the group's offer comes off the table and the group can't be reopened."
              confirmLabel="Dissolve the group"
              pendingLabel="Dissolving…"
              tone="danger"
              variant="ghost"
              className="h-10 text-[13px] font-medium"
            >
              Dissolve
            </ConfirmSubmit>
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

// The listing page's eligibility panel, for a seat. The acknowledgement is taken on the listing, once, and counts
// for a bid and a seat alike. Nothing here stops a seat on its own.
function GroupEligibility({
  listingId,
  eligibility,
  buyer,
  acknowledgedAt,
  acknowledgeFirst,
}: {
  listingId: string;
  eligibility: Eligibility;
  buyer: boolean;
  acknowledgedAt: Date | null;
  acknowledgeFirst: boolean;
}) {
  return (
    <section id="eligibility" aria-labelledby="eligibility-heading" className="mt-6 max-w-2xl scroll-mt-6 border border-border p-5 rounded-xl">
      <h2 id="eligibility-heading" className="eyebrow">Buyer eligibility</h2>
      {eligibility.road && (
        <div className="mt-3 space-y-2 text-sm leading-relaxed text-muted-foreground">
          <p className="text-[13px] font-semibold text-foreground">{ROAD_HEADING}</p>
          <p>{ROAD_NOTICE.join(" ")}</p>
          {buyer && eligibility.holdToRent && <p className="text-foreground">{ROAD_RENT}</p>}
          {buyer && eligibility.unanswered && (
            <p>
              {ROAD_UNANSWERED} <Link href="/buyer/verification#eligibility" className="text-link">Answer in your buyer file</Link>.
            </p>
          )}
          {buyer && eligibility.acknowledge && (acknowledgeFirst ? (
            <p className="text-foreground">
              {ACKNOWLEDGE_FIRST} <Link href={`/marketplace/${listingId}#eligibility`} className="text-link">Acknowledge it on the listing</Link>.
            </p>
          ) : (
            <p className="text-foreground">You acknowledged this notice on {prettyDate(acknowledgedAt)}.</p>
          ))}
        </div>
      )}
      {eligibility.maryland && (
        <div className="mt-4 space-y-2 text-sm leading-relaxed text-muted-foreground">
          <p className="text-[13px] font-semibold text-foreground">{MARYLAND_HEADING}</p>
          <p>{MARYLAND_PROMPT.join(" ")}</p>
        </div>
      )}
    </section>
  );
}
