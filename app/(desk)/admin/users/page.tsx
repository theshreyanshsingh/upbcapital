import { forceSignOut, resetTwoFactor, setAccountStatus, setMembership } from "@/actions/admin";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { SubmitButton } from "@/components/submit-button";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { requireRole } from "@/lib/auth";
import { q } from "@/lib/format";
import { roleLabel } from "@/lib/labels";
import { ofacBlocks } from "@/lib/ofac";
import { prisma } from "@/lib/prisma";
import { literal } from "@/lib/db-filters";

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
  return (
    <div>
      <PageIntro eyebrow="Accounts" title="Who is allowed in." lede="Buyers and institutions wait here until you approve them. Pro can be comped without a charge. Comping a paying buyer or setting them free cancels their Stripe subscription." />
      <Notice notice={q(params, "notice")} error={q(params, "error")} />
      <form action="/admin/users" role="search" className="mt-6 flex max-w-md gap-2">
        <input name="q" type="search" defaultValue={filter} aria-label="Filter accounts" placeholder="Name, email, or company" className="desk-input" />
        <button type="submit" className="h-11 shrink-0 rounded-lg border border-border px-4 text-[13px] font-medium">Filter</button>
      </form>
      {filter && <p className="mt-2 text-sm text-muted-foreground">{users.length} account{users.length === 1 ? "" : "s"} match “{filter}”. <a href="/admin/users" className="text-link">Show all</a></p>}
      <div className="mt-6 overflow-x-auto border border-border rounded-xl">
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
                </td>
                <td className="px-4 py-4">{roleLabel(user.role)}</td>
                <td className="px-4 py-4">{user.accountStatus.toLowerCase()}{user.totpEnabled ? " · 2FA on" : ""}</td>
                <td className="px-4 py-4">{user.role === "BUYER" ? `${user.subscriptionTier.toLowerCase()}${user.subscriptionComped ? " · comped" : ""}` : "—"}</td>
                <td className="px-4 py-4">
                  <div className="flex flex-wrap gap-2">
                    {user.role !== "ADMIN" && user.accountStatus !== "APPROVED" && (
                      <form action={setAccountStatus}>
                        <input type="hidden" name="userId" value={user.id} />
                        <input type="hidden" name="status" value="APPROVED" />
                        <SubmitButton className="h-8 text-[13px] font-medium" pendingLabel="Saving…">{user.accountStatus === "SUSPENDED" ? "Reinstate" : "Approve"}</SubmitButton>
                      </form>
                    )}
                    {user.role !== "ADMIN" && user.accountStatus !== "REJECTED" && user.accountStatus !== "SUSPENDED" && (
                      <form action={setAccountStatus}>
                        <input type="hidden" name="userId" value={user.id} />
                        <input type="hidden" name="status" value="REJECTED" />
                        <ConfirmSubmit title={`Decline ${user.name}'s account?`} consequence="They're told the desk declined the account and can't sign in to trade. Approve them later if this changes." confirmLabel="Decline the account" pendingLabel="Declining…" tone="danger" variant="outline" className="h-8 text-[13px] font-medium">Decline</ConfirmSubmit>
                      </form>
                    )}
                    {user.role !== "ADMIN" && user.accountStatus === "APPROVED" && (
                      <form action={setAccountStatus}>
                        <input type="hidden" name="userId" value={user.id} />
                        <input type="hidden" name="status" value="SUSPENDED" />
                        <ConfirmSubmit title={`Suspend ${user.name}?`} consequence="They're signed out everywhere and can't sign in, bid or answer a sale until the desk reinstates them. Open closings stay open." confirmLabel="Suspend the account" pendingLabel="Suspending…" tone="danger" variant="outline" className="h-8 text-[13px] font-medium">Suspend</ConfirmSubmit>
                      </form>
                    )}
                    {user.id !== actor.id && (
                      <form action={forceSignOut}>
                        <input type="hidden" name="userId" value={user.id} />
                        <SubmitButton variant="ghost" className="h-8 text-[13px] font-medium" pendingLabel="Signing out…">Sign out</SubmitButton>
                      </form>
                    )}
                    {user.id !== actor.id && user.totpEnabled && (
                      <form action={resetTwoFactor}>
                        <input type="hidden" name="userId" value={user.id} />
                        <ConfirmSubmit title={`Clear ${user.name}'s second factor?`} consequence="They're signed out, emailed that it was cleared, and set two-step sign-in up again next time. Do this only after confirming who asked." confirmLabel="Clear it" pendingLabel="Clearing…" variant="ghost" className="h-8 text-[13px] font-medium">Clear 2FA</ConfirmSubmit>
                      </form>
                    )}
                    {user.role === "BUYER" && user.subscriptionTier !== "PRO" && (
                      <form action={setMembership}>
                        <input type="hidden" name="userId" value={user.id} />
                        <input type="hidden" name="tier" value="PRO" />
                        <ConfirmSubmit title={`Comp Pro for ${user.name}?`} consequence="They get Pro until the desk sets them back to free. A Stripe subscription on file is canceled first, so they aren't charged for it." confirmLabel="Comp Pro" pendingLabel="Saving…" variant="ghost" className="h-8 text-[13px] font-medium">Comp Pro</ConfirmSubmit>
                      </form>
                    )}
                    {user.role === "BUYER" && user.subscriptionTier === "PRO" && (
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
