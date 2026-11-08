import { cancelChange, changeEmail, deskResendConfirmation, resendConfirmation, saveEmailConfirmSetting } from "@/actions/email-confirm";
import { SubmitButton } from "@/components/submit-button";
import { demoSeat } from "@/lib/deploy";
import { emailConfirmationRequired } from "@/lib/email-confirm";
import { prettyDate } from "@/lib/format";

type Holder = { email: string; pendingEmail?: string | null; emailConfirmedAt?: Date | null };

// On the security page: the address on the account, whether it is confirmed, and a change of address that waits on
// a link to the new one.
export function EmailAddressSection({ user }: { user: Holder }) {
  const demo = demoSeat(user.email);
  return (
    <section id="email" aria-labelledby="email-heading" className="mt-8 scroll-mt-6 space-y-3 border border-border p-5 rounded-xl">
      <p id="email-heading" className="eyebrow">Email address</p>
      <p className="text-sm text-foreground break-all">{user.email}</p>
      <p className="text-xs text-muted-foreground">
        {user.emailConfirmedAt ? `Confirmed ${prettyDate(user.emailConfirmedAt)}.` : "Not confirmed yet. Open the link we sent to this address."}
      </p>
      {!user.emailConfirmedAt && !user.pendingEmail && (
        <form action={resendConfirmation}>
          <input type="hidden" name="back" value="/account/security#email" />
          <SubmitButton variant="outline" className="h-10 text-[13px] font-medium" pendingLabel="Sending…">Send the link again</SubmitButton>
        </form>
      )}
      {user.pendingEmail ? (
        <div className="space-y-3 rounded-lg border border-link/25 bg-link/5 p-4">
          <p className="text-sm text-foreground">
            Moving to <span className="break-all font-medium">{user.pendingEmail}</span>. The address changes once you open the link we sent there.
          </p>
          <div className="flex flex-wrap gap-2">
            <form action={resendConfirmation}>
              <input type="hidden" name="back" value="/account/security#email" />
              <SubmitButton variant="outline" className="h-9 text-[13px] font-medium" pendingLabel="Sending…">Send the link again</SubmitButton>
            </form>
            <form action={cancelChange}>
              <SubmitButton variant="ghost" className="h-9 text-[13px] font-medium" pendingLabel="Canceling…">Cancel the change</SubmitButton>
            </form>
          </div>
        </div>
      ) : demo ? (
        <p className="text-sm text-muted-foreground">Demo accounts keep their address.</p>
      ) : (
        <form action={changeEmail} className="space-y-3 pt-2">
          <label className="block">
            <span className="text-[13px] text-muted-foreground">New email</span>
            <input name="email" type="email" autoComplete="email" className="desk-input mt-2" required />
          </label>
          <label className="block">
            <span className="text-[13px] text-muted-foreground">Current password</span>
            <input name="password" type="password" autoComplete="current-password" className="desk-input mt-2" required />
          </label>
          <p className="text-xs text-muted-foreground">We send a link to the new address and tell the current one. Your email changes only when the link is opened, and other devices are signed out then.</p>
          <SubmitButton variant="outline" className="h-11 text-[13px] font-medium" pendingLabel="Sending…">Change email</SubmitButton>
        </form>
      )}
    </section>
  );
}

// On Accounts: whether the account proved its address, with a fresh link for one that hasn't.
export function EmailConfirmState({ user, canResend }: { user: Holder & { id: string; role: string }; canResend: boolean }) {
  if (user.role === "ADMIN") return null;
  if (user.emailConfirmedAt && !user.pendingEmail) return <p className="mt-1 text-xs text-muted-foreground">Email confirmed</p>;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs">
      <span className="text-muted-foreground">{user.emailConfirmedAt ? "New email waiting for confirmation" : "Email not confirmed"}</span>
      {canResend && (
        <form action={deskResendConfirmation}>
          <input type="hidden" name="userId" value={user.id} />
          <button type="submit" className="font-medium text-link">Resend the link</button>
        </form>
      )}
    </div>
  );
}

// On the settings page: the gate on bids, listings, awards, signatures and messages.
export function EmailConfirmSetting({ value, owns }: { value: boolean | null | undefined; owns: boolean }) {
  const current = value === true ? "on" : value === false ? "off" : "default";
  const releaseOn = emailConfirmationRequired({ requireEmailConfirmation: null });
  return (
    <form id="email-confirmation" action={saveEmailConfirmSetting} className="mt-8 scroll-mt-6 space-y-5 glass p-6" aria-labelledby="email-confirmation-heading">
      <div>
        <p id="email-confirmation-heading" className="eyebrow">Email confirmation</p>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          When it is on, an account opens the link we email at signup before it bids, lists, accepts an award, signs or messages. Accounts the desk invited, firm seats and desk staff are confirmed already. A change of address waits on the same link either way.
        </p>
        <p className="mt-2 text-sm text-foreground">Now: {emailConfirmationRequired({ requireEmailConfirmation: value }) ? "on" : "off"}.</p>
      </div>
      <label className="block">
        <span className="text-[13px] text-muted-foreground">Require a confirmed email</span>
        <select name="requireEmailConfirmation" defaultValue={current} disabled={!owns} className="desk-input mt-2">
          <option value="default">Default: on in release builds, off in the demo ({releaseOn ? "on here" : "off here"})</option>
          <option value="on">On</option>
          <option value="off">Off</option>
        </select>
      </label>
      {owns ? <SubmitButton className="h-11 text-[13px] font-medium" pendingLabel="Saving…">Save the gate</SubmitButton> : <p className="text-sm text-muted-foreground">Only an owner changes the gate.</p>}
    </form>
  );
}
