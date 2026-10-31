import QRCode from "qrcode";
import { acknowledgeRecovery, beginTotp, changePassword, confirmTotp, disableTotp, revokeOtherSessions, revokeSession, setEmailFallback } from "@/actions/security";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { SubmitButton } from "@/components/submit-button";
import { adminNeedsSecondFactor } from "@/lib/access";
import { currentSessionId, requireUser } from "@/lib/auth";
import { prettyDate, q } from "@/lib/format";
import { deliverable } from "@/lib/mail-config";
import { prisma } from "@/lib/prisma";
import { otpauthUrl } from "@/lib/totp";

export const metadata = { title: "Security" };

export default async function SecurityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser({ secondFactorSetup: true });
  const params = await searchParams;
  const [sessions, thisSession] = await Promise.all([
    prisma.serverSession.findMany({ where: { userId: user.id, expiresAt: { gt: new Date() } }, orderBy: { createdAt: "desc" } }),
    currentSessionId(),
  ]);
  const setupRequired = adminNeedsSecondFactor(user);
  const pending = Boolean(user.totpSecret) && !user.totpEnabled;
  const qr = pending ? await QRCode.toString(otpauthUrl(user.totpSecret, user.email), { type: "svg", margin: 1, width: 180, color: { dark: "#111111", light: "#ffffff" } }) : "";
  const codes = user.recoveryReveal.split("\n").filter(Boolean);
  return (
    <div className="max-w-xl">
      <PageIntro
        eyebrow="Security"
        title="A second factor."
        lede="Scan the code into an authenticator. Keep the recovery codes. Email codes are optional, and only if you turn them on."
      />
      <Notice notice={q(params, "notice")} error={q(params, "error")} />
      {setupRequired && (
        <p role="alert" className="mt-4 border border-bad/40 bg-bad/10 px-4 py-3 text-sm text-bad rounded-xl">
          Desk admins need an authenticator. Set it up here and the desk opens.
        </p>
      )}
      {codes.length > 0 && (
        <section className="mt-8 border border-link/40 bg-link/5 p-5 rounded-xl">
          <p className="eyebrow">Recovery codes</p>
          <p className="mt-2 text-sm text-muted-foreground">Each code works once, in place of the authenticator. This is the only time they are shown.</p>
          <ul className="mt-4 grid gap-2 sm:grid-cols-2">
            {codes.map((code) => <li key={code} className="font-semibold tracking-tight text-2xl text-foreground">{code}</li>)}
          </ul>
          <form action={acknowledgeRecovery} className="mt-4">
            <SubmitButton className="h-11 text-[13px] font-medium">I have written these down</SubmitButton>
          </form>
        </section>
      )}
      {user.totpEnabled ? (
        <div className="mt-8 space-y-4">
          <form action={disableTotp} className="space-y-4 border border-border p-5 rounded-xl">
            <p className="text-sm text-foreground">Codes are required at sign-in.</p>
            <label className="block">
              <span className="text-[13px] text-muted-foreground">Current code or recovery code</span>
              <input name="code" autoComplete="one-time-code" aria-label="Current authenticator or recovery code" className="desk-input mt-2" required />
            </label>
            <SubmitButton variant="outline" className="h-11 text-[13px] font-medium">Turn off</SubmitButton>
          </form>
          <form action={setEmailFallback} className="space-y-3 border border-border p-5 rounded-xl">
            <p className="eyebrow">Email fallback</p>
            <p className="text-sm text-muted-foreground">When this is on, the sign-in screen can email a six-digit code.</p>
            <input type="hidden" name="enabled" value={user.emailOtpFallback ? "no" : "yes"} />
            <SubmitButton variant="outline" className="h-11 text-[13px] font-medium">
              {user.emailOtpFallback ? "Turn email codes off" : "Turn email codes on"}
            </SubmitButton>
          </form>
        </div>
      ) : pending ? (
        <div className="mt-8 space-y-4 border border-border p-5 rounded-xl">
          <p className="text-sm text-muted-foreground">Scan this with an authenticator, or enter the secret by hand.</p>
          <div className="max-w-[200px] rounded-xl border border-border bg-white p-3" dangerouslySetInnerHTML={{ __html: qr }} />
          <p className="break-all font-semibold tracking-tight text-2xl text-foreground">{user.totpSecret}</p>
          <form action={confirmTotp} className="space-y-3">
            <label className="block">
              <span className="text-[13px] text-muted-foreground">Code</span>
              <input name="code" inputMode="numeric" autoComplete="one-time-code" aria-label="Authenticator code" className="desk-input mt-2" required />
            </label>
            <SubmitButton className="h-11 text-[13px] font-medium">Confirm</SubmitButton>
          </form>
        </div>
      ) : (
        <form action={beginTotp} className="mt-8">
          <SubmitButton className="h-11 text-[13px] font-medium">Set up authenticator</SubmitButton>
        </form>
      )}

      {deliverable(user.email) && (
        <form action={changePassword} className="mt-8 space-y-3 border border-border p-5 rounded-xl">
          <p className="eyebrow">Password</p>
          <label className="block">
            <span className="text-[13px] text-muted-foreground">Current password</span>
            <input name="current" type="password" autoComplete="current-password" aria-label="Current password" className="desk-input mt-2" required />
          </label>
          <label className="block">
            <span className="text-[13px] text-muted-foreground">New password</span>
            <input name="password" type="password" autoComplete="new-password" minLength={8} aria-label="New password" className="desk-input mt-2" required />
          </label>
          <label className="block">
            <span className="text-[13px] text-muted-foreground">Same password again</span>
            <input name="confirm" type="password" autoComplete="new-password" minLength={8} aria-label="Confirm new password" className="desk-input mt-2" required />
          </label>
          <SubmitButton variant="outline" className="h-11 text-[13px] font-medium">Change password</SubmitButton>
        </form>
      )}

      <section className="mt-8 border border-border p-5 rounded-xl">
        <p className="eyebrow">Signed-in devices</p>
        <ul className="mt-3 divide-y divide-border">
          {sessions.map((session) => (
            <li key={session.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm text-foreground">{session.userAgent || "Unknown device"}</p>
                <p className="text-xs text-muted-foreground">
                  Since {prettyDate(session.createdAt)}{session.ipAddress ? ` · ${session.ipAddress}` : ""}{session.id === thisSession ? " · this device" : ""}
                </p>
              </div>
              {session.id !== thisSession && (
                <form action={revokeSession}>
                  <input type="hidden" name="id" value={session.id} />
                  <SubmitButton variant="ghost" className="h-9 text-[13px] font-medium">Sign out</SubmitButton>
                </form>
              )}
            </li>
          ))}
        </ul>
        {sessions.length > 1 && (
          <form action={revokeOtherSessions} className="mt-3">
            <SubmitButton variant="outline" className="h-10 text-[13px] font-medium">Sign out everywhere else</SubmitButton>
          </form>
        )}
      </section>
    </div>
  );
}
