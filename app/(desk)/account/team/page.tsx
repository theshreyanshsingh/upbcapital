import Link from "next/link";
import { redirect } from "next/navigation";
import {
  approveHeldBid,
  declineHeldBid,
  inviteTeamSeat,
  removeTeamSeat,
  resendTeamInvite,
  revokeTeamInvite,
  saveTeamSeat,
  withdrawHeldBid,
} from "@/actions/seats";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { SubmitButton } from "@/components/submit-button";
import { requireUser } from "@/lib/auth";
import { money, prettyDate, q } from "@/lib/format";
import {
  SEAT_INVITE_DAYS,
  SEAT_ROLES,
  SEAT_ROLE_HINTS,
  SEAT_ROLE_LABELS,
  canApproveBids,
  canManageSeats,
  firmName,
  pendingSeatBids,
  personId,
  seatActivity,
  seatRoleLabel,
  seatRoleOf,
  takesSeats,
  teamOf,
} from "@/lib/seats";

export const metadata = { title: "Team" };

const dollars = (cents: number | null | undefined) => (cents == null ? "" : String(cents / 100));

// The firm's seats: who is on the account and with what role, the invitations out, the bids waiting for approval,
// and what each seat did lately. Everyone on the account reads it. Managing seats and the owner change it.
export default async function TeamPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  if (user.role === "ADMIN") redirect("/admin/users");
  if (!takesSeats(user.role)) {
    return (
      <div className="max-w-3xl">
        <PageIntro eyebrow="Team" title="Seats on this account." lede="Seats let a bank, credit union, fund or brokerage put several people on one account." />
        <p className="text-sm text-muted-foreground">This is a personal seller account, so it has no seats. Write the desk if you sell for a firm.</p>
      </div>
    );
  }
  const params = await searchParams;
  const manages = canManageSeats(user);
  const approves = canApproveBids(user);
  const me = personId(user);
  const firm = firmName(user);
  const [team, held, activity] = await Promise.all([teamOf(user.id), pendingSeatBids(user.id), seatActivity(user.id)]);
  return (
    <div className="max-w-3xl">
      <PageIntro
        eyebrow="Team"
        title="Seats on this account."
        lede={`Each colleague signs in with their own email, password and second factor, and acts for ${firm} with the role given here.`}
      />
      <Notice notice={q(params, "notice")} error={q(params, "error")} />
      {user.actor && (
        <p className="mt-4 text-sm text-muted-foreground">
          You are signed in as {user.actor.name}, with a {seatRoleLabel(seatRoleOf(user)).toLowerCase()} seat.
          {!manages && " The account owner or a managing seat changes the team."}
        </p>
      )}

      <section id="seats" aria-labelledby="seats-heading" className="mt-8 scroll-mt-6 border border-border p-5 rounded-xl">
        <h2 id="seats-heading" className="eyebrow">Seats</h2>
        <ul className="mt-3 divide-y divide-border">
          <li className="py-3">
            <p className="text-sm text-foreground">{user.name}{me === user.id ? " · you" : ""}</p>
            <p className="text-xs text-muted-foreground">{user.email} · the account owner, who manages everything</p>
          </li>
          {team.seats.map((seat) => {
            const role = seatRoleLabel(seat.seatRole);
            return (
              <li key={seat.id} className="py-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm text-foreground">{seat.name}{seat.id === me ? " · you" : ""}</p>
                    <p className="text-xs text-muted-foreground">
                      {seat.email} · {role}
                      {seat.seatRole === "TRADE" && seat.seatBidLimitCents != null ? ` · bids above ${money(seat.seatBidLimitCents / 100)} wait for approval` : ""}
                      {seat.totpEnabled ? " · two-step on" : ""} · added {prettyDate(seat.seatAddedAt)}
                    </p>
                  </div>
                  {manages && seat.id !== me && (
                    <form action={removeTeamSeat}>
                      <input type="hidden" name="seatId" value={seat.id} />
                      <ConfirmSubmit
                        title={`Remove ${seat.name}'s seat?`}
                        consequence={`${seat.name} is signed out everywhere and can no longer act for ${firm}. What they did stays in the record. You can invite the address again later.`}
                        confirmLabel="Remove the seat"
                        pendingLabel="Removing…"
                        tone="danger"
                        variant="ghost"
                        className="h-8 text-[13px] font-medium"
                      >
                        Remove
                      </ConfirmSubmit>
                    </form>
                  )}
                </div>
                {manages && seat.id !== me && (
                  <form action={saveTeamSeat} className="mt-3 flex flex-wrap items-end gap-3">
                    <input type="hidden" name="seatId" value={seat.id} />
                    <label className="block">
                      <span className="text-xs text-muted-foreground">Role</span>
                      <select name="seatRole" defaultValue={seat.seatRole ?? "VIEW"} aria-label={`Role for ${seat.name}`} className="desk-input mt-1 h-9 w-36">
                        {SEAT_ROLES.map((value) => <option key={value} value={value}>{SEAT_ROLE_LABELS[value]}</option>)}
                      </select>
                    </label>
                    <label className="block">
                      <span className="text-xs text-muted-foreground">Bid limit, trading seats</span>
                      <input name="bidLimit" inputMode="decimal" defaultValue={dollars(seat.seatBidLimitCents)} placeholder="None" aria-label={`Bid limit for ${seat.name}`} className="desk-input mt-1 h-9 w-40 tabular-nums" />
                    </label>
                    <SubmitButton variant="outline" className="h-9 text-[13px] font-medium" pendingLabel="Saving…">Save</SubmitButton>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
        {team.seats.length === 0 && <p className="mt-2 text-sm text-muted-foreground">No seats yet. Only the account owner signs in.</p>}
        <dl className="mt-4 grid gap-2 border-t border-border pt-4 text-xs text-muted-foreground sm:grid-cols-2">
          {SEAT_ROLES.map((value) => (
            <div key={value}>
              <dt className="inline font-medium text-foreground">{SEAT_ROLE_LABELS[value]}.</dt> <dd className="inline">{SEAT_ROLE_HINTS[value]}</dd>
            </div>
          ))}
        </dl>
      </section>

      {manages && (
        <section id="invite" aria-labelledby="invite-heading" className="mt-6 scroll-mt-6 border border-border p-5 rounded-xl">
          <h2 id="invite-heading" className="eyebrow">Invite a colleague</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            They get a link to set their name and password, good for {SEAT_INVITE_DAYS} days. An address that already has its own account here can&apos;t take a seat.
          </p>
          <form action={inviteTeamSeat} className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="text-[13px] text-muted-foreground">Work email</span>
              <input name="email" type="email" required autoComplete="off" className="desk-input mt-2" />
            </label>
            <label className="block">
              <span className="text-[13px] text-muted-foreground">Name (optional)</span>
              <input name="name" maxLength={120} autoComplete="off" className="desk-input mt-2" />
            </label>
            <label className="block">
              <span className="text-[13px] text-muted-foreground">Role</span>
              <select name="seatRole" defaultValue="VIEW" className="desk-input mt-2">
                {SEAT_ROLES.map((value) => <option key={value} value={value}>{SEAT_ROLE_LABELS[value]}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="text-[13px] text-muted-foreground">Bid limit for a trading seat (optional)</span>
              <input name="bidLimit" inputMode="decimal" placeholder="None" className="desk-input mt-2 tabular-nums" />
            </label>
            <div className="sm:col-span-2">
              <SubmitButton className="h-10 text-[13px] font-medium" pendingLabel="Sending…">Send the invitation</SubmitButton>
            </div>
          </form>
        </section>
      )}

      {team.invites.length > 0 && (
        <section id="invites" aria-labelledby="invites-heading" className="mt-6 scroll-mt-6 border border-border p-5 rounded-xl">
          <h2 id="invites-heading" className="eyebrow">Invitations out</h2>
          <ul className="mt-3 divide-y divide-border">
            {team.invites.map((invite) => (
              <li key={invite.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                <div className="min-w-0 text-sm">
                  <p className="text-foreground">{invite.name || invite.email} · {seatRoleLabel(invite.seatRole)}</p>
                  <p className="text-xs text-muted-foreground">
                    {invite.email} · sent {prettyDate(invite.createdAt)}
                    {invite.seatRole === "TRADE" && invite.bidLimitCents != null ? ` · limit ${money(invite.bidLimitCents / 100)}` : ""}
                  </p>
                  {invite.lapsed && <p className="mt-1 text-xs text-warn">The link has lapsed. Send it again if they still need it.</p>}
                </div>
                {manages && (
                  <div className="flex flex-wrap gap-2">
                    <form action={resendTeamInvite}>
                      <input type="hidden" name="inviteId" value={invite.id} />
                      <SubmitButton variant="outline" className="h-8 text-[13px] font-medium" pendingLabel="Sending…">Send again</SubmitButton>
                    </form>
                    <form action={revokeTeamInvite}>
                      <input type="hidden" name="inviteId" value={invite.id} />
                      <SubmitButton variant="ghost" className="h-8 text-[13px] font-medium" pendingLabel="Withdrawing…">Withdraw</SubmitButton>
                    </form>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section id="approvals" aria-labelledby="approvals-heading" className="mt-6 scroll-mt-6 border border-border p-5 rounded-xl">
        <h2 id="approvals-heading" className="eyebrow">Bids waiting for approval</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          A trading seat&apos;s bid above its limit waits here. Approving places it with every check the bid form runs, as of then. It closes at the listing&apos;s bid deadline.
        </p>
        {held.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">Nothing is waiting.</p>
        ) : (
          <ul className="mt-3 divide-y divide-border">
            {held.map((bid) => {
              const own = bid.requestedById === me;
              return (
                <li key={bid.id} className="py-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-3">
                    <div className="min-w-0">
                      {bid.listingId ? (
                        <Link href={`/marketplace/${bid.listingId}`} className="text-sm font-medium text-foreground">{bid.listingTitle}</Link>
                      ) : (
                        <p className="text-sm font-medium text-foreground">{bid.listingTitle}</p>
                      )}
                      <p className="text-xs text-muted-foreground">
                        {bid.requesterName}{own ? " (you)" : ""} · asked {prettyDate(bid.createdAt)}
                        {bid.limitCents != null ? ` · limit ${money(bid.limitCents / 100)}` : ""}
                        {bid.expiresAt ? ` · closes ${prettyDate(bid.expiresAt)}` : ""}
                      </p>
                    </div>
                    <p className="text-sm tabular-nums text-foreground">{money(bid.amountCents / 100)}</p>
                  </div>
                  {own ? (
                    <form action={withdrawHeldBid} className="mt-3">
                      <input type="hidden" name="approvalId" value={bid.id} />
                      <SubmitButton variant="outline" className="h-8 text-[13px] font-medium" pendingLabel="Withdrawing…">Withdraw</SubmitButton>
                    </form>
                  ) : approves ? (
                    <div className="mt-3 flex flex-wrap items-end gap-3">
                      <form action={approveHeldBid}>
                        <input type="hidden" name="approvalId" value={bid.id} />
                        <ConfirmSubmit
                          title={`Place ${bid.requesterName}'s bid of ${money(bid.amountCents / 100)}?`}
                          consequence={`The bid goes in for ${firm} on ${bid.listingTitle}, with you as the approver. If the desk accepts it, the firm is committed to buy at this price plus the buyer premium.`}
                          confirmLabel="Approve and place it"
                          pendingLabel="Placing…"
                          className="h-9 text-[13px] font-medium"
                        >
                          Approve
                        </ConfirmSubmit>
                      </form>
                      <form action={declineHeldBid} className="flex flex-wrap items-end gap-2">
                        <input type="hidden" name="approvalId" value={bid.id} />
                        <label className="block">
                          <span className="text-xs text-muted-foreground">Reason to decline</span>
                          <input name="reason" required minLength={3} maxLength={500} aria-label={`Reason to decline ${bid.requesterName}'s bid`} className="desk-input mt-1 h-9 w-56" />
                        </label>
                        <SubmitButton variant="outline" className="h-9 text-[13px] font-medium" pendingLabel="Declining…">Decline</SubmitButton>
                      </form>
                    </div>
                  ) : (
                    <p className="mt-2 text-xs text-muted-foreground">An approving or managing seat, or the account owner, decides it.</p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section id="activity" aria-labelledby="activity-heading" className="mt-6 scroll-mt-6 border border-border p-5 rounded-xl">
        <h2 id="activity-heading" className="eyebrow">What the seats did</h2>
        {activity.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">No seat has acted for the account yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-border">
            {activity.map((event) => (
              <li key={event.id} className="py-2.5 text-sm">
                <p className="text-foreground">
                  {event.seatName} · {event.action.replaceAll("_", " ").toLowerCase()}
                </p>
                <p className="text-xs text-muted-foreground">{prettyDate(event.createdAt)}{event.detail ? ` · ${event.detail}` : ""}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
