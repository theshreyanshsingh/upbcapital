import { resendInvitation, sendInvite, withdrawInvitation } from "@/actions/invites";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { SubmitButton } from "@/components/submit-button";
import { prettyDate } from "@/lib/format";
import { INVITE_DAYS, inviteLapsed, openInvites } from "@/lib/invites";
import { roleLabel } from "@/lib/labels";
import { prisma } from "@/lib/prisma";
import { deskCan } from "@/lib/staff";

// The accounts page's invitations: the form, and the ones not yet accepted, which the desk can send again or withdraw.
export async function InvitePanel({ actor }: { actor: { role: string; deskRole?: string | null } }) {
  if (!deskCan(actor, "admin")) return null;
  const invites = await openInvites();
  const inviterIds = [...new Set(invites.map((invite) => invite.invitedById).filter((id): id is string => Boolean(id)))];
  const inviters = new Map((inviterIds.length ? await prisma.user.findMany({ where: { id: { in: inviterIds } }, select: { id: true, name: true } }) : []).map((row) => [row.id, row.name]));
  const now = new Date();
  return (
    <section id="invites" aria-labelledby="invites-heading" className="mt-6 border border-border p-5 rounded-xl">
      <h2 id="invites-heading" className="eyebrow">Invitations</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Set up an account for a buyer, seller or broker you already know. They get a link to choose a password, good for {INVITE_DAYS} days, then accept the terms and set up two-step sign-in.
      </p>
      <form action={sendInvite} className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Name</span>
          <input name="name" required minLength={2} maxLength={120} autoComplete="off" className="desk-input mt-2" />
        </label>
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Email</span>
          <input name="email" type="email" required autoComplete="off" className="desk-input mt-2" />
        </label>
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Company</span>
          <input name="companyName" maxLength={160} autoComplete="off" className="desk-input mt-2" />
        </label>
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Account</span>
          <select name="role" defaultValue="BUYER" className="desk-input mt-2">
            <option value="BUYER">Buyer</option>
            <option value="INSTITUTIONAL_SELLER">Institution selling</option>
            <option value="INDIVIDUAL_SELLER">Note seller</option>
            <option value="BROKER">Broker</option>
          </select>
        </label>
        <fieldset className="sm:col-span-2">
          <legend className="text-[13px] text-muted-foreground">Starts as</legend>
          <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2 text-sm text-foreground">
            <label className="flex items-center gap-2">
              <input type="radio" name="status" value="PENDING" defaultChecked className="accent-link" />
              Waiting for review, like a sign-up
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="status" value="APPROVED" className="accent-link" />
              Approved now
            </label>
          </div>
        </fieldset>
        <div className="sm:col-span-2">
          <SubmitButton className="h-10 text-[13px] font-medium" pendingLabel="Sending…">Send the invitation</SubmitButton>
        </div>
      </form>
      {invites.length > 0 && (
        <ul className="mt-5 divide-y divide-border border-t border-border">
          {invites.map((invite) => (
            <li key={invite.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
              <div className="min-w-0 text-sm">
                <p className="text-foreground">{invite.name} · {roleLabel(invite.role)}{invite.companyName ? ` · ${invite.companyName}` : ""}</p>
                <p className="text-xs text-muted-foreground">
                  {invite.email} · invited {prettyDate(invite.invitedAt)}{invite.invitedById && inviters.get(invite.invitedById) ? ` by ${inviters.get(invite.invitedById)}` : ""} · starts {invite.accountStatus.toLowerCase()}
                </p>
                {inviteLapsed(invite.invitedAt, now) && <p className="mt-1 text-xs text-warn">The link has lapsed. Send it again if they still want in.</p>}
              </div>
              <div className="flex flex-wrap gap-2">
                <form action={resendInvitation}>
                  <input type="hidden" name="userId" value={invite.id} />
                  <SubmitButton variant="outline" className="h-8 text-[13px] font-medium" pendingLabel="Sending…">Send again</SubmitButton>
                </form>
                <form action={withdrawInvitation}>
                  <input type="hidden" name="userId" value={invite.id} />
                  <ConfirmSubmit
                    title={`Withdraw ${invite.name}'s invitation?`}
                    consequence="The link stops working and the unused account is removed. The audit log keeps the invitation. You can invite them again later."
                    confirmLabel="Withdraw it"
                    pendingLabel="Withdrawing…"
                    tone="danger"
                    variant="ghost"
                    className="h-8 text-[13px] font-medium"
                  >
                    Withdraw
                  </ConfirmSubmit>
                </form>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
