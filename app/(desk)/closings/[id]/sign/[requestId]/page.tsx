import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { declineSignature, signSignature } from "@/actions/signatures";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { Notice } from "@/components/notice";
import { SignerList, statusLine } from "@/components/signature-panel";
import { SubmitButton } from "@/components/submit-button";
import { canReadClosingFile } from "@/lib/acl";
import { requireUser } from "@/lib/auth";
import { q } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { ESIGN_CONSENT, kindLabel, requestView, roleLabel, vendorName } from "@/lib/signatures";

export const metadata = { title: "Sign" };

// One request's signer page: the copy sent, where each party stands, and the viewer's own line to sign or decline.
export default async function SignPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; requestId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id, requestId } = await params;
  const query = await searchParams;
  const user = await requireUser();
  const request = await prisma.signatureRequest.findFirst({
    where: { id: requestId, closingId: id },
    include: { closing: { select: { inquiryId: true, listing: { select: { title: true, sellerId: true } }, funders: { select: { userId: true } } } } },
  });
  if (!request) notFound();
  const inquiry = request.closing.inquiryId ? await prisma.inquiry.findUnique({ where: { id: request.closing.inquiryId }, select: { buyerId: true } }) : null;
  const allowed = canReadClosingFile({
    role: user.role,
    userId: user.id,
    sellerId: request.closing.listing.sellerId,
    buyerId: inquiry?.buyerId ?? null,
    funderIds: request.closing.funders.map((funder) => funder.userId),
  });
  if (!allowed) redirect("/closings");
  const view = requestView(request, user);
  const me = view.signers.find((signer) => signer.mine);
  const label = kindLabel(view.kind);
  return (
    <div className="max-w-2xl">
      <Link href={`/closings/${id}`} className="text-[13px] font-medium text-link">
        Back to the closing
      </Link>
      <div className="mt-4">
        <Notice notice={q(query, "notice")} error={q(query, "error")} />
      </div>
      <p className="eyebrow mt-4">Signature · {label}</p>
      <h1 className="mt-3 font-semibold tracking-tight text-[28px] text-foreground">{request.closing.listing.title}</h1>
      <p className="mt-3 text-sm text-muted-foreground">{statusLine(view)}</p>
      <section className="mt-8 glass p-6">
        <p className="eyebrow">The document</p>
        <p className="mt-2 text-sm text-muted-foreground">Read the copy sent for signature before you sign. Every party signs this same file.</p>
        <a className="mt-3 inline-block text-[13px] font-medium text-link" href={`/api/closings/${id}/packet?kind=${view.kind}&request=${view.id}`}>
          Open the {label.toLowerCase()} (PDF)
        </a>
        <p className="mt-2 break-all text-xs text-muted-foreground">SHA-256 fingerprint {view.documentHash}</p>
      </section>
      <section className="mt-6 glass p-6">
        <p className="eyebrow">Parties</p>
        <SignerList signers={view.signers} />
      </section>
      {view.canSign && me && (
        <section id="sign" aria-labelledby="sign-heading" className="mt-6 scroll-mt-6 glass p-6">
          <p id="sign-heading" className="eyebrow">Sign</p>
          <p className="mt-2 text-sm text-muted-foreground">
            You sign for {me.name}, as the {roleLabel(me.role).toLowerCase()}.
          </p>
          <form action={signSignature} className="mt-4 space-y-4">
            <input type="hidden" name="closingId" value={id} />
            <input type="hidden" name="requestId" value={view.id} />
            <label className="block">
              <span className="text-[13px] text-muted-foreground">Your full legal name</span>
              <input name="signedName" required minLength={2} maxLength={120} autoComplete="name" className="desk-input mt-2" />
            </label>
            <label className="flex items-start gap-3 text-sm text-foreground">
              <input type="checkbox" name="consent" required className="mt-1" />
              <span>{ESIGN_CONSENT}</span>
            </label>
            <SubmitButton className="h-11 text-[13px] font-medium" pendingLabel="Signing…">
              Sign
            </SubmitButton>
          </form>
          <details className="mt-6 border-t border-border pt-4">
            <summary className="cursor-pointer text-[13px] font-medium text-muted-foreground">Decline to sign</summary>
            <form action={declineSignature} className="mt-3 space-y-3">
              <input type="hidden" name="closingId" value={id} />
              <input type="hidden" name="requestId" value={view.id} />
              <label className="block">
                <span className="text-[13px] text-muted-foreground">Why you&apos;re declining</span>
                <textarea name="reason" required minLength={3} maxLength={500} className="desk-input mt-2 min-h-20" />
              </label>
              <ConfirmSubmit
                title="Decline to sign?"
                consequence="The request closes for every party, and the desk reads your reason. The closing stays open while the desk sorts it out."
                confirmLabel="Decline"
                pendingLabel="Declining…"
                tone="danger"
                variant="outline"
                className="h-9 text-[13px] font-medium"
              >
                Decline
              </ConfirmSubmit>
            </form>
          </details>
        </section>
      )}
      {view.live && me?.state === "waiting" && view.provider !== "in_app" && (
        <p className="mt-6 text-sm text-muted-foreground">Sign from the email {vendorName(view.provider)} sent you. This page updates when you do.</p>
      )}
    </div>
  );
}
