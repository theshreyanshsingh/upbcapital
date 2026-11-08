"use client";

import { useActionState } from "react";
import { MailCheck } from "lucide-react";
import { resendFromBanner, type ResendState } from "@/actions/email-confirm";

const empty: ResendState = { notice: "", error: "" };

// A quiet line in the signed-in shell until the account confirms its address. Browsing works meanwhile; bids,
// listings and signatures wait (lib/email-confirm.ts).
export function EmailConfirmBanner({ email }: { email: string }) {
  const [state, action, pending] = useActionState(resendFromBanner, empty);
  return (
    <form action={action} role="status" className="mb-5 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-link/25 bg-link/5 px-3.5 py-2 text-[13px] text-foreground print:hidden">
      <MailCheck aria-hidden className="size-4 shrink-0 text-link" />
      <span className="min-w-0 break-words">Confirm your email to bid, list and sign. We sent a link to {email}.</span>
      {state.notice || state.error ? (
        <span className={state.error ? "text-bad" : "text-muted-foreground"}>{state.error || state.notice}</span>
      ) : (
        <button type="submit" disabled={pending} className="font-medium text-link disabled:opacity-60">{pending ? "Sending…" : "Send the link again"}</button>
      )}
    </form>
  );
}
