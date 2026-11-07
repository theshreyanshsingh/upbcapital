import { forceSignOut, resetTwoFactor, setAccountStatus, setMembership } from "@/actions/admin";
import { saveDeskRole } from "@/actions/staff";
import { clearBuyerStrike } from "@/actions/strikes";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { InvitePanel } from "@/components/invite-panel";
import { SubmitButton } from "@/components/submit-button";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { requireRole } from "@/lib/auth";
import { prettyDate, q } from "@/lib/format";
import { invitePending } from "@/lib/invites";
import { roleLabel } from "@/lib/labels";
import { ofacBlocks } from "@/lib/ofac";
import { prisma } from "@/lib/prisma";
import { literal } from "@/lib/db-filters";
import { getSettings } from "@/lib/settings";
import { DESK_ROLE_HINTS, DESK_ROLE_LABELS, DESK_ROLES, deskCan, deskRoleOf } from "@/lib/staff";
import { strikeLimitOf, strikesFor, type StrikeRow } from "@/lib/strikes";

export const metadata = { title: "Accounts" };

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await requireRole(["ADMIN"]);
  const params = await searchParams;
  const filter = q(params, "q").trim().slice(0, 80);
  const text = { contains: literal(filter), mode: "insensitive" as const };
  const [users, reviews] = await Promise.all([
    prisma.user.findMany({
      where: filter ? { OR: [{ name: text }, { email: text }, { companyName: text }] } : undefined,
      orderBy: { createdAt: "desc" },
    }),
    prisma.ofacCheck.findMany({ where: { result: "REVIEW" }, select: { userId: true, result: true, status: true } }),
  ]);
  const held = new Set(reviews.filter(ofacBlocks).map((row) => row.userId));
  const [strikes, settings] = await Promise.all([strikesFor(users.filter((user) => user.role === "BUYER").map((user) => user.id)), getSettings()]);
  const limit = strikeLimitOf(settings.strikeLimit);
  // Forms show only for the part of the desk this account runs. The actions check the same capabilities.
  const vets = deskCan(actor, "compliance");
  const owns = deskCan(actor, "admin");
  const staff = await prisma.user.findMany({ where: { role: "ADMIN" }, orderBy: { name: "asc" }, select: { id: true, name: true, email: true, deskRole: true, role: true, accountStatus: true } });
  return (
    <div>
      <PageIntro eyebrow="Accounts" title="Who is allowed in." lede="Buyers and institutions wait here until you approve them. Pro can be comped without a charge. Comping a paying buyer or setting them free cancels their Stripe subscription." />
      <Notice notice={q(params, "notice")} error={q(params, "error")} />
      <InvitePanel actor={actor} />
      <section id="staff" aria-labelledby="staff-heading" className="mt-6 scroll-mt-6 border border-border p-5 rounded-xl">
        <p id="staff-heading" className="eyebrow">Desk staff</p>
        <p className="mt-2 text-sm text-muted-foreground">
          Each desk account has a role. Sales reads sealed bids; the desk book never does. A wire change needs a second person who approves wires. {owns ? "Only owners set roles, and the desk always keeps one owner." : "Only an owner changes these."}
        </p>
        <ul className="mt-4 divide-y divide-border">
          {staff.map((member) => {
            const current = deskRoleOf(member) ?? "OWNER";
            return (
              <li key={member.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="text-sm text-foreground">{member.name}{member.id === actor.id ? " · you" : ""}</p>
                  <p className="text-xs text-muted-foreground">{member.email}{member.accountStatus !== "APPROVED" ? ` · ${member.accountStatus.toLowerCase()}` : ""}</p>
                  <p className="text-xs text-muted-foreground">{DESK_ROLE_LABELS[current]}: {DESK_ROLE_HINTS[current]}</p>
                </div>
                {owns ? (
                  <form action={saveDeskRole} className="flex items-center gap-2">
                    <input type="hidden" name="userId" value={member.id} />
                    <select name="deskRole" defaultValue={current} aria-label={`Desk role for ${member.name}`} className="desk-input h-9 w-40">
                      {DESK_ROLES.map((role) => <option key={role} value={role}>{DESK_ROLE_LABELS[role]}</option>)}
                    </select>
                    <SubmitButton variant="outline" className="h-9 text-[13px] font-medium" pendingLabel="Saving…">Save</SubmitButton>
                  </form>
                ) : (
                  <span className="text-[13px] font-medium text-muted-foreground">{DESK_ROLE_LABELS[current]}</span>
                )}
              </li>
            );
          })}
        </ul>
      </section>
      <form action="/admin/users" role="search" className="mt-6 flex max-w-md gap-2">
        <input name="q" type="search" defaultValue={filter} aria-label="Filter accounts" placeholder="Name, email, or company" className="desk-input" />
        <button type="submit" className="h-11 shrink-0 rounded-lg border border-border px-4 text-[13px] font-medium">Filter</button>
      </form>
      {filter && <p className="mt-2 text-sm text-muted-foreground">{users.length} account{users.length === 1 ? "" : "s"} match “{filter}”. <a href="/admin/users" className="text-link">Show all</a></p>}
      <div className="mt-6 relative overflow-x-auto border border-border rounded-xl">
        <table className="min-w-full text-left text-sm">
          <thead className="text-xs font-medium text-muted-foreground">
            <tr>
              {["Name", "Role", "Status", "Membership", ""].map((heading) => <th key={heading} className="px-4 py-3 font-normal">{heading}</th>)}
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id} className="border-t border-border align-top">
                <td className="px-4 py-4">
                  <p className="text-foreground">{user.name}</p>
                  <p className="text-xs text-muted-foreground">{user.email}</p>
                  {user.companyName && <p className="text-xs text-muted-foreground">{user.companyName}</p>}
                  {held.has(user.id) && <p className="mt-1 text-xs text-bad">OFAC review open</p>}
                  {invitePending(user) && <p className="mt-1 text-xs text-link">Invited · password not set yet</p>}
                  <Strikes rows={strikes.get(user.id) ?? []} limit={limit} canClear={vets} />
                </td>
                <td className="px-4 py-4">{roleLabel(user.role)}</td>
                <td className="px-4 py-4">{user.accountStatus.toLowerCase()}{user.totpEnabled ? " · 2FA on" : ""}</td>
                <td className="px-4 py-4">{user.role === "BUYER" ? `${user.subscriptionTier.toLowerCase()}${user.subscriptionComped ? " · comped" : ""}` : "—"}</td>
                <td className="px-4 py-4">
                  <div className="flex flex-wrap gap-2">
                    {vets && user.role !== "ADMIN" && user.accountStatus !== "APPROVED" && (
                      <form action={setAccountStatus}>
                        <input type="hidden" name="userId" value={user.id} />
                        <input type="hidden" name="status" value="APPROVED" />
                        <SubmitButton className="h-8 text-[13px] font-medium" pendingLabel="Saving…">{user.accountStatus === "SUSPENDED" ? "Reinstate" : "Approve"}</SubmitButton>
                      </form>
                    )}
                    {vets && user.role !== "ADMIN" && user.accountStatus !== "REJECTED" && user.accountStatus !== "SUSPENDED" && (
                      <form action={setAccountStatus}>
                        <input type="hidden" name="userId" value={user.id} />
                        <input type="hidden" name="status" value="REJECTED" />
                        <ConfirmSubmit title={`Decline ${user.name}'s account?`} consequence="They're told the desk declined the account and can't sign in to trade. Approve them later if this changes." confirmLabel="Decline the account" pendingLabel="Declining…" tone="danger" variant="outline" className="h-8 text-[13px] font-medium">Decline</ConfirmSubmit>
                      </form>
                    )}
                    {vets && user.role !== "ADMIN" && user.accountStatus === "APPROVED" && (
                      <form action={setAccountStatus}>
                        <input type="hidden" name="userId" value={user.id} />
                        <input type="hidden" name="status" value="SUSPENDED" />
                        <ConfirmSubmit title={`Suspend ${user.name}?`} consequence="They're signed out everywhere and can't sign in, bid or answer a sale until the desk reinstates them. Open closings stay open." confirmLabel="Suspend the account" pendingLabel="Suspending…" tone="danger" variant="outline" className="h-8 text-[13px] font-medium">Suspend</ConfirmSubmit>
                      </form>
                    )}
                    {owns && user.id !== actor.id && (
                      <form action={forceSignOut}>
                        <input type="hidden" name="userId" value={user.id} />
                        <SubmitButton variant="ghost" className="h-8 text-[13px] font-medium" pendingLabel="Signing out…">Sign out</SubmitButton>
                      </form>
                    )}
                    {owns && user.id !== actor.id && user.totpEnabled && (
                      <form action={resetTwoFactor}>
                        <input type="hidden" name="userId" value={user.id} />
                        <ConfirmSubmit title={`Clear ${user.name}'s second factor?`} consequence="They're signed out, emailed that it was cleared, and set two-step sign-in up again next time. Do this only after confirming who asked." confirmLabel="Clear it" pendingLabel="Clearing…" variant="ghost" className="h-8 text-[13px] font-medium">Clear 2FA</ConfirmSubmit>
                      </form>
                    )}
                    {owns && user.role === "BUYER" && user.subscriptionTier !== "PRO" && (
                      <form action={setMembership}>
                        <input type="hidden" name="userId" value={user.id} />
                        <input type="hidden" name="tier" value="PRO" />
                        <ConfirmSubmit title={`Comp Pro for ${user.name}?`} consequence="They get Pro until the desk sets them back to free. A Stripe subscription on file is canceled first, so they aren't charged for it." confirmLabel="Comp Pro" pendingLabel="Saving…" variant="ghost" className="h-8 text-[13px] font-medium">Comp Pro</ConfirmSubmit>
                      </form>
                    )}
                    {owns && user.role === "BUYER" && user.subscriptionTier === "PRO" && (
                      <form action={setMembership}>
                        <input type="hidden" name="userId" value={user.id} />
                        <input type="hidden" name="tier" value="FREE" />
                        <ConfirmSubmit title={`Set ${user.name} to free?`} consequence="They lose Pro now. A Stripe subscription on file is canceled, with no refund from here." confirmLabel="Set to free" pendingLabel="Saving…" tone="danger" variant="ghost" className="h-8 text-[13px] font-medium">Set free</ConfirmSubmit>
                      </form>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// A buyer's closings that didn't complete, folded under their name. Clearing one takes a note for the audit log.
function Strikes({ rows, limit, canClear }: { rows: StrikeRow[]; limit: number; canClear: boolean }) {
  if (!rows.length) return null;
  const active = rows.filter((row) => !row.clearedAt).length;
  return (
    <details className="mt-1 max-w-sm">
      <summary className={`cursor-pointer text-xs font-medium tabular-nums ${active >= limit ? "text-bad" : "text-foreground"}`}>
        {active} of {limit} strikes active{active >= limit ? " · bidding paused" : ""}
      </summary>
      <ul className="mt-2 space-y-3">
        {rows.map((row) => (
          <li key={row.id} className="text-xs">
            <p className="text-foreground">
              <a className="text-link" href={`/closings/${row.closingId}`}>{row.listingTitle}</a> · {prettyDate(row.createdAt)}
            </p>
            <p className="text-muted-foreground">{row.reason}</p>
            {row.clearedAt ? (
              <p className="text-muted-foreground">Cleared {prettyDate(row.clearedAt)}. {row.clearNote}</p>
            ) : !canClear ? null : (
              <form action={clearBuyerStrike} className="mt-1 space-y-1">
                <input type="hidden" name="strikeId" value={row.id} />
                <input type="hidden" name="back" value="/admin/users" />
                <label className="block">
                  <span className="text-muted-foreground">Why the desk is clearing it</span>
                  <input name="note" required minLength={10} className="desk-input mt-1" />
                </label>
                <ConfirmSubmit
                  title={`Clear the strike for ${row.listingTitle}?`}
                  consequence="It stops counting toward the buyer's limit. If that takes them under the limit, their bidding resumes at once. Your note goes in the audit log."
                  typed={[["Note", "note", "text"]]}
                  confirmLabel="Clear the strike"
                  pendingLabel="Clearing…"
                  variant="outline"
                  className="h-8 text-[13px] font-medium"
                >
                  Clear strike
                </ConfirmSubmit>
              </form>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}
