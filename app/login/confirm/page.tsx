import Link from "next/link";
import { confirmEmailLink, resendConfirmation } from "@/actions/email-confirm";
import { Logo } from "@/components/logo";
import { Notice } from "@/components/notice";
import { SubmitButton } from "@/components/submit-button";
import { getCurrentUser } from "@/lib/auth";
import { CONFIRM_HOURS, peekConfirmation, type ConfirmState } from "@/lib/email-confirm";
import { q } from "@/lib/format";
import { homeFor } from "@/lib/labels";

// The token is in this page's URL, so it must not travel in a Referer header.
export const metadata = { title: "Confirm your email", referrer: "no-referrer" as const };
export const dynamic = "force-dynamic";

const COPY: Record<ConfirmState | "start", { title: string; lede: string; resend: boolean }> = {
  start: { title: "Confirm your email.", lede: `Open the link we emailed you. It works once, for ${CONFIRM_HOURS} hours.`, resend: true },
  confirmed: { title: "Your address is confirmed.", lede: "You can bid, list and sign now.", resend: false },
  changed: { title: "Your email address changed.", lede: "Sign in with the new address from now on. Other devices were signed out, and the old address was told.", resend: false },
  used: { title: "This link was already used.", lede: "Each link works once. If your address still shows as unconfirmed, send a new link.", resend: true },
  expired: { title: "This link has expired.", lede: `Links work for ${CONFIRM_HOURS} hours. Send a new one.`, resend: true },
  replaced: { title: "This link was replaced.", lede: "A newer link, or a later change of address, took its place. Use the newest email we sent.", resend: true },
  taken: { title: "That address is taken.", lede: "Another account took the address before you confirmed it, so your email stays as it was. Choose another on the security page.", resend: false },
  invalid: { title: "This link doesn't work.", lede: "It may be cut short. Copy the whole link from the email, or send a new one.", resend: true },
};

function stateOf(value: string): ConfirmState | "start" {
  return Object.hasOwn(COPY, value) ? (value as ConfirmState) : "start";
}

export default async function ConfirmEmailPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const token = q(params, "token") ?? "";
  // Opening the link only reads it. A mail scanner, or the owner of a mistyped address, confirms nothing unless they
  // press the button, which posts the token and lands on ?state= without it.
  const peek = token ? await peekConfirmation(token) : null;
  if (peek?.state === "ready") {
    return (
      <main id="desk" className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-5 py-16">
        <Logo />
        <p className="eyebrow mt-12">Email</p>
        <h1 className="mt-3 font-semibold tracking-tight text-[28px] text-foreground">{peek.change ? "Confirm your new email." : "Confirm your email."}</h1>
        <p className="mt-4 text-sm text-muted-foreground break-words">
          {peek.change
            ? `Press the button to move your UPB Capital account to ${peek.email}. Other devices are signed out when it moves.`
            : `Press the button to confirm that ${peek.email} is yours.`}{" "}
          If you didn&apos;t ask for this, close the page and nothing happens.
        </p>
        <form action={confirmEmailLink} className="mt-8">
          <input type="hidden" name="token" value={token} />
          <SubmitButton className="h-11 w-full text-[13px] font-medium" pendingLabel="Confirming…">Confirm my email</SubmitButton>
        </form>
      </main>
    );
  }
  const state = peek ? peek.state : stateOf(q(params, "state") ?? "");
  const copy = COPY[state];
  const viewer = await getCurrentUser();
  // A firm's seat proved its own address when it took the seat, so the firm's state isn't its to resend.
  const waiting = Boolean(viewer && !viewer.actor && (!viewer.emailConfirmedAt || viewer.pendingEmail));
  return (
    <main id="desk" className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-5 py-16">
      <Logo />
      <p className="eyebrow mt-12">Email</p>
      <h1 className="mt-3 font-semibold tracking-tight text-[28px] text-foreground">{copy.title}</h1>
      <p className="mt-4 text-sm text-muted-foreground">{copy.lede}</p>
      <div className="mt-8">
        <Notice notice={q(params, "notice")} error={q(params, "error")} />
      </div>
      {copy.resend && viewer && waiting ? (
        <form action={resendConfirmation} className="mt-6">
          <input type="hidden" name="back" value={`/login/confirm?state=${state}`} />
          <SubmitButton className="h-11 w-full text-[13px] font-medium" pendingLabel="Sending…">Send a new link</SubmitButton>
        </form>
      ) : copy.resend && !viewer ? (
        <p className="mt-6 text-sm text-muted-foreground">
          <Link href="/login?next=/login/confirm" className="text-link">Sign in</Link> to send a new link.
        </p>
      ) : null}
      <p className="mt-6 text-sm text-muted-foreground">
        {viewer ? <Link href={homeFor(viewer.role)} className="text-link">Go to your desk</Link> : <Link href="/login" className="text-link">Sign in</Link>}
      </p>
    </main>
  );
}
