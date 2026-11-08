import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { setBuyerBidCap } from "@/actions/desk-tools";
import { DeskNotes } from "@/components/desk-notes";
import { DeskRecord } from "@/components/track-record";
import { FileOwners } from "@/components/file-owners";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { SubmitButton } from "@/components/submit-button";
import { Stat } from "@/components/ui/stat";
import { requireRole } from "@/lib/auth";
import { capLine, newBidderLine } from "@/lib/bid-caps";
import { fileKey } from "@/lib/beneficial-owners";
import { deskEntityStatus } from "@/lib/buyer-entities";
import { buyerDeskProfile, rateText } from "@/lib/buyer-desk";
import { money, prettyDate, q } from "@/lib/format";
import { entityLabel } from "@/lib/labels";
import { DESK_DENIED, deskCan, deskWrites } from "@/lib/staff";
import { recertLapsed } from "@/lib/verification";
import { deskSeatLines } from "@/lib/seats";

export const metadata = { title: "Buyer" };

const lower = (value: string) => value.replaceAll("_", " ").toLowerCase();

export default async function BuyerDeskPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireRole(["ADMIN"]);
  // The sales side reads it to award, compliance to vet. Sealed amounts follow the viewer's role (lib/buyer-desk.ts).
  if (!deskCan(user, "sales") && !deskCan(user, "compliance")) redirect(`/admin?error=${encodeURIComponent(DESK_DENIED)}`);
  const { id } = await params;
  const query = await searchParams;
  const now = new Date();
  const profile = await buyerDeskProfile(user, id, now);
  if (!profile) notFound();
  const { user: buyer, file, cap, rates } = profile;
  const vets = deskCan(user, "compliance");
  const back = `/admin/buyers/${buyer.id}`;
  const sealedBids = profile.bids.filter((bid) => bid.sealed).length;
  const limit = capLine(cap);
  // The firm's seats and their roles, when colleagues sign in for it (lib/seats.ts).
  const seatLine = (await deskSeatLines([{ id: buyer.id }])).get(buyer.id);
  return (
    <div>
      <PageIntro
        eyebrow="Buyer"
        title={file?.entityName || buyer.companyName || buyer.name}
        lede={`${buyer.name} · ${buyer.email} · ${lower(buyer.accountStatus)} account · ${buyer.subscriptionTier === "PRO" ? "Pro" : "Free"} · joined ${prettyDate(buyer.createdAt)}`}
      />
      <Notice notice={q(query, "notice")} error={q(query, "error")} />
      <div className="mt-6 flex flex-wrap gap-4 text-[13px] font-medium">
        <Link className="text-link" href={`/admin/verification#buyer-${buyer.id}`}>Open in buyer files</Link>
        <Link className="text-link" href={`/admin/audit?${new URLSearchParams({ entityType: "user", entityId: buyer.id }).toString()}`}>Account in the audit log</Link>
      </div>
      {seatLine && <p className="mt-3 text-sm text-muted-foreground">{seatLine}</p>}

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Bids" value={<span className="tabular-nums">{rates.bids}</span>} basis={`${rates.decided} decided`} />
        <Stat label="Win rate" value={rateText(rates.winRate)} basis={`${rates.won} won of ${rates.decided} decided`} />
        <Stat label="Close rate" value={rateText(rates.closeRate)} basis={`${rates.closed} closed of ${rates.finished} finished`} />
        <Stat label="Strikes" value={<span className="tabular-nums">{profile.activeStrikes}</span>} basis={`Bidding pauses at ${profile.strikeLimit}`} />
      </div>
      {/* The factual record sellers read beside this buyer's bids, with open and withdrawn claims. components/track-record.tsx. */}
      <DeskRecord userId={buyer.id} className="mt-6" />

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <section aria-labelledby="file-heading" className="rounded-xl border border-border p-5">
          <p id="file-heading" className="eyebrow">Buyer file</p>
          {!file ? (
            <p className="mt-2 text-sm text-muted-foreground">No buyer file yet.</p>
          ) : (
            <>
              <p className="mt-2 text-sm text-foreground">
                {lower(file.status)} · {entityLabel(file.entityType).toLowerCase()}{file.jurisdiction ? ` · ${file.jurisdiction}` : ""} · {file.accredited ? "self-certified accredited" : "not certified"}
              </p>
              <p className={`mt-1 text-sm ${recertLapsed(file, now) ? "text-bad" : "text-muted-foreground"}`}>
                {file.status !== "APPROVED"
                  ? `Submitted ${prettyDate(file.submittedAt)}`
                  : file.recertifyBy
                    ? recertLapsed(file, now)
                      ? `Re-certification lapsed ${prettyDate(file.recertifyBy)}. New bids are paused.`
                      : `Current until ${prettyDate(file.recertifyBy)}`
                    : "Approved before yearly re-certification began, so it stays current."}
              </p>
              <p className="mt-1 text-sm text-foreground">
                {file.proofVerifiedAt && file.proofAmount != null
                  ? `Verified funds ${money(file.proofAmount)} through ${prettyDate(file.proofExpiresAt)}${file.proofExpiresAt && file.proofExpiresAt.getTime() < now.getTime() ? " · expired" : ""}`
                  : file.proofAmount != null
                    ? `Buyer states ${money(file.proofAmount)} · not verified yet`
                    : "No funds amount stated"}
              </p>
              {file.reviewerNote && <p className="mt-1 text-xs text-muted-foreground">Desk note to the buyer: {file.reviewerNote}</p>}
              <FileOwners owners={profile.owners.get(fileKey(buyer.id, null)) ?? []} entityType={file.entityType} taxIdLast4={file.taxIdLast4 ?? null} />
            </>
          )}
          {profile.entities.length > 0 && (
            <div className="mt-4">
              <p className="text-[13px] font-medium text-foreground">Other buying entities</p>
              <ul className="mt-2 divide-y divide-border">
                {profile.entities.map((entity) => (
                  <li key={entity.id} className="py-3 text-sm">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="font-medium text-foreground">{entity.name}</p>
                      <p className="text-[13px] font-medium text-link">{deskEntityStatus(entity.status)}</p>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {entityLabel(entity.entityType)}
                      {entity.entityType === "IRA" ? ` · custodian ${entity.iraCustodian}` : entity.jurisdiction ? ` · formed in ${entity.jurisdiction}` : ""}
                      {entity.reviewedAt ? ` · decided ${prettyDate(entity.reviewedAt)}` : ` · added ${prettyDate(entity.createdAt)}`}
                    </p>
                    <FileOwners owners={profile.owners.get(fileKey(buyer.id, entity.id)) ?? []} entityType={entity.entityType} taxIdLast4={entity.taxIdLast4 ?? null} />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        <section id="bid-cap" aria-labelledby="bid-cap-heading" className="scroll-mt-6 rounded-xl border border-border p-5">
          <p id="bid-cap-heading" className="eyebrow">Bid limit</p>
          <p className="mt-2 text-sm font-medium text-foreground">
            {cap.capCents != null ? `Largest single bid ${money(cap.capCents / 100)}` : "No limit on one bid"}
            {cap.source === "funds" ? " · set by verified funds" : cap.source === "desk" ? " · set by the desk" : cap.source === "newBidder" ? " · new-bidder cap" : ""}
          </p>
          <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
            <li>{cap.deskCapCents != null ? `Desk cap ${money(cap.deskCapCents / 100)}.` : "No desk cap."}</li>
            <li>{newBidderLine(cap)}</li>
            {limit && <li>The buyer reads: {limit}</li>}
          </ul>
          {vets ? (
            <div className="mt-4 space-y-4">
              <form action={setBuyerBidCap} className="space-y-3">
                <input type="hidden" name="userId" value={buyer.id} />
                <input type="hidden" name="mode" value="cap" />
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block">
                    <span className="text-[13px] text-muted-foreground">Desk cap on one bid</span>
                    <input name="capDollars" inputMode="decimal" defaultValue={cap.deskCapCents != null ? String(cap.deskCapCents / 100) : ""} placeholder="No cap" className="desk-input mt-2 tabular-nums" />
                  </label>
                  <label className="block">
                    <span className="text-[13px] text-muted-foreground">Reason</span>
                    <input name="reason" required minLength={3} maxLength={200} className="desk-input mt-2" />
                  </label>
                </div>
                <SubmitButton variant="outline" className="h-10 text-[13px] font-medium" pendingLabel="Saving…">Save the desk cap</SubmitButton>
              </form>
              {cap.newBidder !== "off" && (
                <form action={setBuyerBidCap} className="flex flex-wrap items-end gap-2">
                  <input type="hidden" name="userId" value={buyer.id} />
                  <input type="hidden" name="mode" value={buyer.bidCapLifted ? "restore" : "lift"} />
                  <label className="block min-w-56 flex-1">
                    <span className="text-[13px] text-muted-foreground">Reason</span>
                    <input name="reason" required minLength={3} maxLength={200} className="desk-input mt-2" />
                  </label>
                  <SubmitButton variant="outline" className="h-10 text-[13px] font-medium" pendingLabel="Saving…">
                    {buyer.bidCapLifted ? "Restore the new-bidder cap" : "Lift the new-bidder cap"}
                  </SubmitButton>
                </form>
              )}
              <p className="text-xs text-muted-foreground">Each change goes in the audit log with its reason, and the buyer hears their new limit.</p>
            </div>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">Compliance sets bid caps.</p>
          )}
        </section>
      </div>

      <section aria-labelledby="bids-heading" className="mt-8">
        <p id="bids-heading" className="eyebrow">Bids</p>
        {sealedBids > 0 && <p className="mt-2 text-sm text-muted-foreground">Your desk role doesn&apos;t read sealed bids, so {sealedBids} amount{sealedBids === 1 ? " stays" : "s stay"} hidden until the deadline.</p>}
        <ul className="mt-3 divide-y divide-border rounded-xl border border-border">
          {profile.bids.length === 0 && <li className="px-5 py-6 text-sm text-muted-foreground">No bids yet.</li>}
          {profile.bids.map((bid) => (
            <li key={bid.id} className="flex flex-wrap items-baseline justify-between gap-3 px-5 py-3 text-sm">
              <div className="min-w-0">
                <Link href={`/admin/listings/${bid.listingId}`} className="font-medium text-foreground">{bid.listingTitle}</Link>
                <p className="text-xs text-muted-foreground">{bid.loan}{bid.buyNow ? " · buy it now" : ""} · {prettyDate(bid.createdAt)}</p>
              </div>
              <p className="tabular-nums text-foreground">
                {bid.sealed ? "Sealed" : bid.amount != null ? money(bid.amount) : "—"} <span className="text-[13px] font-medium text-link">· {lower(bid.status)}</span>
              </p>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="closings-heading" className="mt-8">
        <p id="closings-heading" className="eyebrow">Closings</p>
        <ul className="mt-3 divide-y divide-border rounded-xl border border-border">
          {profile.closings.length === 0 && <li className="px-5 py-6 text-sm text-muted-foreground">No closings yet.</li>}
          {profile.closings.map((closing) => (
            <li key={closing.id} className="flex flex-wrap items-baseline justify-between gap-3 px-5 py-3 text-sm">
              <div className="min-w-0">
                <Link href={`/closings/${closing.id}`} className="font-medium text-foreground">{closing.listingTitle}</Link>
                <p className="text-xs text-muted-foreground">
                  {closing.as === "funder" ? "Group funder" : closing.as === "lead" ? "Group lead" : "Winning buyer"} · opened {prettyDate(closing.openedAt)}
                  {closing.endedAt ? ` · ${closing.status === "COMPLETE" ? "closed" : "ended"} ${prettyDate(closing.endedAt)}` : ""}
                  {closing.cancelReason ? ` · ${closing.cancelReason}` : ""}
                </p>
              </div>
              <p className="tabular-nums text-foreground">
                {closing.price != null ? money(closing.price) : "Sealed"}
                {closing.theirShare != null && closing.as !== "buyer" ? ` · their share ${money(closing.theirShare)}` : ""}
                <span className={`text-[13px] font-medium ${closing.status === "CANCELED" ? "text-bad" : "text-link"}`}> · {lower(closing.status)}</span>
              </p>
            </li>
          ))}
        </ul>
      </section>

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <section aria-labelledby="strikes-heading" className="rounded-xl border border-border p-5">
          <p id="strikes-heading" className="eyebrow">Strikes</p>
          {profile.strikes.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">None.</p>
          ) : (
            <>
              <p className={`mt-2 text-[13px] font-medium tabular-nums ${profile.activeStrikes >= profile.strikeLimit ? "text-bad" : "text-foreground"}`}>
                {profile.activeStrikes} of {profile.strikeLimit} active{profile.activeStrikes >= profile.strikeLimit ? " · bidding paused" : ""}
              </p>
              <ul className="mt-2 divide-y divide-border">
                {profile.strikes.map((strike) => (
                  <li key={strike.id} className="py-2 text-sm">
                    <p className="text-foreground"><Link className="text-link" href={`/closings/${strike.closingId}`}>{strike.listingTitle}</Link> · {prettyDate(strike.createdAt)}</p>
                    <p className="text-xs text-muted-foreground">{strike.reason}{strike.clearedAt ? ` · cleared ${prettyDate(strike.clearedAt)}. ${strike.clearNote}` : ""}</p>
                  </li>
                ))}
              </ul>
              {vets && <p className="mt-2 text-xs text-muted-foreground">Clear a strike from the buyer files page.</p>}
            </>
          )}
        </section>
        <section aria-labelledby="holdings-heading" className="rounded-xl border border-border p-5">
          <p id="holdings-heading" className="eyebrow">Holdings</p>
          {profile.holdings.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">None on file.</p>
          ) : (
            <ul className="mt-2 divide-y divide-border">
              {profile.holdings.map((holding) => (
                <li key={holding.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2 text-sm">
                  <span className="text-foreground">{holding.title}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {money(holding.costBasis)} for {money(holding.upb)} UPB{holding.sharePercent != null ? ` · ${holding.sharePercent.toFixed(1)}% share` : ""} · {lower(holding.status)} · {prettyDate(holding.acquiredAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <div className="mt-8">
        <DeskNotes subjectType="user" subjectId={buyer.id} back={back} viewerId={user.id} readOnly={!deskWrites(user)} />
      </div>

      <section aria-labelledby="log-heading" className="mt-8">
        <p id="log-heading" className="eyebrow">Audit trail</p>
        <p className="mt-1 text-xs text-muted-foreground">What the buyer did, what the desk did to the account, and what happened on their bids. The latest 100, newest first. Times are UTC.</p>
        <ul className="mt-3 divide-y divide-border rounded-xl border border-border">
          {profile.audit.length === 0 && <li className="px-5 py-6 text-sm text-muted-foreground">Nothing in the log yet.</li>}
          {profile.audit.map((event) => (
            <li key={event.id} className="grid gap-1 px-5 py-3 md:grid-cols-[180px_160px_1fr]">
              <p className="text-[13px] font-medium text-muted-foreground">
                {prettyDate(event.createdAt)} <span className="tabular-nums">{event.createdAt.toISOString().slice(11, 16)}</span>
              </p>
              <p className="text-[13px] font-medium text-link">{lower(event.action)}</p>
              <p className="min-w-0 break-words text-sm text-foreground">
                {event.actor} · {event.entityType}
                {event.detail ? <span className="mt-1 block text-muted-foreground">{event.detail}</span> : null}
              </p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
