import { requestAccountDeletion } from "@/actions/account-deletion";
import { SubmitButton } from "@/components/submit-button";
import { demoSeat } from "@/lib/deploy";
import { prettyDate } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";

// The last section of the security page: ask the desk to delete the account, or see where the request stands.
export async function AccountDeletion({ user }: { user: { id: string; email: string } }) {
  const [latest, settings] = await Promise.all([
    prisma.deletionRequest.findFirst({ where: { userId: user.id }, orderBy: { requestedAt: "desc" } }),
    getSettings(),
  ]);
  const waiting = latest?.status === "REQUESTED";
  return (
    <section id="delete" aria-labelledby="delete-heading" className="mt-8 scroll-mt-6 border border-border p-5 rounded-xl">
      <p id="delete-heading" className="eyebrow">Delete the account</p>
      <p className="mt-2 text-sm text-muted-foreground">
        The desk removes your name, email, phone and company, signs out every device, and deletes your saved searches, buy boxes, API keys and webhooks. Deal records stay for {settings.retentionYears} years because the law requires it: closings, signed papers, NDAs and the audit log. An open bid, closing, listing or group seat has to finish first.
      </p>
      {latest?.status === "REFUSED" && (
        <p className="mt-3 text-sm text-foreground">The desk refused your request of {prettyDate(latest.requestedAt)}: {latest.note}</p>
      )}
      {waiting ? (
        <p className="mt-3 text-sm text-foreground">You asked on {prettyDate(latest.requestedAt)}. The desk is reviewing it, and you&apos;ll hear by email.</p>
      ) : demoSeat(user.email) ? (
        <p className="mt-3 text-sm text-muted-foreground">The demo seats can&apos;t be deleted.</p>
      ) : (
        <form action={requestAccountDeletion} className="mt-4 space-y-3">
          <label className="block">
            <span className="text-[13px] text-muted-foreground">Why, if you&apos;d like to say</span>
            <textarea name="reason" maxLength={500} aria-label="Reason for deleting the account" className="desk-input mt-2 min-h-20" />
          </label>
          <label className="flex items-start gap-2 text-sm text-foreground">
            <input type="checkbox" name="confirm" value="yes" required className="mt-1" />
            I want this account deleted. It can&apos;t be undone.
          </label>
          <SubmitButton variant="outline" pendingLabel="Sending…" className="h-11 text-[13px] font-medium">Ask the desk to delete it</SubmitButton>
        </form>
      )}
    </section>
  );
}
