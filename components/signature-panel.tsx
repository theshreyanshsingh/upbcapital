import { saveSignHours, sendSignatures, voidSignatures } from "@/actions/signatures";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { SubmitButton } from "@/components/submit-button";
import { buttonVariants } from "@/components/ui/button";
import { TEMPLATE_KEYS } from "@/lib/closing-docs";
import { timelineStamp } from "@/lib/closing-service";
import { deskCan } from "@/lib/desk-roles";
import { getSettings } from "@/lib/settings";
import { DEFAULT_SIGN_HOURS, MAX_SIGN_HOURS, kindLabel, roleLabel, signHours, signatureView, statusLabel, vendorName, type RequestView, type SignerView } from "@/lib/signatures";
import { cn } from "@/lib/utils";

// Where a request stands, in a sentence for the panel and the signer page.
export function statusLine(request: RequestView) {
  if (request.live) return request.dueAt ? `Every party signs by ${timelineStamp(request.dueAt)}.` : "Waiting for every party to sign.";
  if (request.status === "SIGNED") return `Every party signed${request.completedAt ? ` ${timelineStamp(request.completedAt)}` : ""}.`;
  if (request.status === "DECLINED") return "A party declined, so this request is closed.";
  if (request.status === "EXPIRED") return "The time to sign ran out. The closing stays open.";
  return `The desk withdrew this request.${request.voidReason ? ` Reason: ${request.voidReason}` : ""}`;
}

function statusTone(status: string) {
  return status === "SIGNED" ? "text-good" : status === "DECLINED" || status === "EXPIRED" ? "text-bad" : status === "VOIDED" ? "text-muted-foreground" : "text-link";
}

export function SignerList({ signers }: { signers: SignerView[] }) {
  return (
    <ul className="mt-3 divide-y divide-border">
      {signers.map((signer, index) => (
        <li key={`${signer.role}-${index}`} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-2.5">
          <div className="min-w-0">
            <p className="text-sm text-foreground">
              {signer.name}
              {signer.mine ? " (you)" : ""}
            </p>
            <p className="text-xs text-muted-foreground">
              {roleLabel(signer.role)}
              {signer.signedName ? ` · signed as ${signer.signedName}` : ""}
              {signer.ip ? ` · from ${signer.ip}` : ""}
              {signer.declineReason ? ` · ${signer.declineReason}` : ""}
            </p>
          </div>
          <p className={cn("text-[13px] font-medium", signer.state === "signed" ? "text-good" : signer.state === "declined" ? "text-bad" : "text-muted-foreground")}>
            {signer.state === "signed" ? `Signed${signer.at ? ` ${timelineStamp(signer.at)}` : ""}` : signer.state === "declined" ? "Declined" : "Waiting"}
          </p>
        </li>
      ))}
    </ul>
  );
}

// The closing's papers out for signature. The desk sees every request and, with the closings role, sends, sends
// again and voids. A party sees the newest request for each form, their own Sign button and where the others stand.
export async function SignaturePanel({ closingId, open, viewer }: { closingId: string; open: boolean; viewer: { id: string; role: string; deskRole?: string | null } }) {
  const runs = viewer.role === "ADMIN" && deskCan(viewer, "closings") && open;
  const [requests, settings] = await Promise.all([signatureView(closingId, viewer), getSettings()]);
  const hours = signHours(settings.psaSignHours);
  const newest = new Set(requests.filter((request, index) => requests.findIndex((row) => row.kind === request.kind) === index).map((request) => request.id));
  return (
    <section id="signatures" aria-labelledby="signatures-heading" className="mt-6 scroll-mt-6 glass p-6">
      <p id="signatures-heading" className="eyebrow">Signatures</p>
      <p className="mt-2 text-sm text-muted-foreground">Every party signs the same copy within {hours} hours of it being sent. A signed purchase agreement completes its step.</p>
      {requests.length === 0 && <p className="mt-4 text-sm text-muted-foreground">{runs ? "Nothing is out for signature yet." : "The desk hasn't sent anything for signature yet."}</p>}
      {requests.length > 0 && (
        <ul className="mt-4 space-y-4">
          {requests.map((request) => (
            <li key={request.id} className="rounded-lg border border-border p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                <p className="font-medium text-foreground">{kindLabel(request.kind)}</p>
                <p className={cn("text-[13px] font-medium", statusTone(request.status))}>{statusLabel(request.status)}</p>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Sent {timelineStamp(request.sentAt)}
                {request.provider !== "in_app" ? ` through ${vendorName(request.provider)}` : ""}. {statusLine(request)}
              </p>
              <SignerList signers={request.signers} />
              <div className="mt-3 flex flex-wrap items-center gap-3">
                {request.canSign ? (
                  <a href={`/closings/${closingId}/sign/${request.id}`} className={buttonVariants({ className: "h-9 text-[13px] font-medium" })}>
                    Sign
                  </a>
                ) : (
                  <a href={`/closings/${closingId}/sign/${request.id}`} className="text-[13px] font-medium text-link">
                    Read the copy sent
                  </a>
                )}
                {request.live && request.mine && request.provider !== "in_app" && (
                  <p className="text-xs text-muted-foreground">Sign from the email {vendorName(request.provider)} sent you.</p>
                )}
                {runs && newest.has(request.id) && request.status !== "SIGNED" && (
                  <form action={sendSignatures}>
                    <input type="hidden" name="closingId" value={closingId} />
                    <input type="hidden" name="kind" value={request.kind} />
                    <ConfirmSubmit
                      title={`Send the ${kindLabel(request.kind).toLowerCase()} again?`}
                      consequence={`A fresh copy goes to every party with ${hours} hours to sign.${request.live ? " This one is voided, so nobody signs it." : ""}`}
                      confirmLabel="Send again"
                      pendingLabel="Sending…"
                      variant="outline"
                      className="h-9 text-[13px] font-medium"
                    >
                      Send again
                    </ConfirmSubmit>
                  </form>
                )}
              </div>
              {runs && request.live && (
                <form action={voidSignatures} className="mt-3 flex flex-wrap items-center gap-2">
                  <input type="hidden" name="closingId" value={closingId} />
                  <input type="hidden" name="requestId" value={request.id} />
                  <input name="reason" required minLength={3} maxLength={500} placeholder="Why it's void" aria-label={`Reason to void the ${kindLabel(request.kind).toLowerCase()}`} className="desk-input h-9 w-56" />
                  <ConfirmSubmit
                    title={`Void the ${kindLabel(request.kind).toLowerCase()} out for signature?`}
                    consequence="Every party is told not to sign it, with your reason. The closing stays open."
                    typed={[["Reason", "reason", "text"]]}
                    confirmLabel="Void"
                    pendingLabel="Voiding…"
                    tone="danger"
                    variant="outline"
                    className="h-9 text-[13px] font-medium"
                  >
                    Void
                  </ConfirmSubmit>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
      {runs && (
        <form action={sendSignatures} className="mt-5 flex flex-wrap items-end gap-3 border-t border-border pt-4">
          <input type="hidden" name="closingId" value={closingId} />
          <label className="block">
            <span className="text-[13px] text-muted-foreground">Form</span>
            <select name="kind" defaultValue="PSA" className="desk-input mt-2 h-9 w-48">
              {TEMPLATE_KEYS.map((key) => (
                <option key={key} value={key}>
                  {kindLabel(key)}
                </option>
              ))}
            </select>
          </label>
          <ConfirmSubmit
            title="Send for signature?"
            consequence={`Every party gets a link and has ${hours} hours to sign. A copy of the same form still out is voided, so everyone signs the new one.`}
            confirmLabel="Send"
            pendingLabel="Sending…"
            className="h-9 text-[13px] font-medium"
          >
            Send for signature
          </ConfirmSubmit>
        </form>
      )}
    </section>
  );
}

// The settings page's field for the time to sign. Only an owner saves it.
export function SignatureSettings({ owns, setting }: { owns: boolean; setting: number | null | undefined }) {
  return (
    <form id="signing" action={saveSignHours} className="mt-8 scroll-mt-6 space-y-5 glass p-6" aria-labelledby="signing-heading">
      <div>
        <p id="signing-heading" className="eyebrow">Signing papers</p>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          When the desk sends closing papers for signature, every party signs within this many hours. Each is reminded once halfway through. When the time runs out the request closes and the desk is told. The closing stays open.
        </p>
        <p className="mt-2 text-sm text-foreground">
          Now: {signHours(setting)} hours{setting == null ? ", the default" : ""}.
        </p>
      </div>
      <label className="block">
        <span className="text-[13px] text-muted-foreground">Hours to sign</span>
        {/* With no save button for other roles, a lone text field would still submit on Enter, so it reads only. */}
        <input name="psaSignHours" inputMode="numeric" disabled={!owns} defaultValue={setting ?? ""} placeholder={`${DEFAULT_SIGN_HOURS}, the default`} className="desk-input mt-2 tabular-nums" />
        <span className="mt-1 block text-xs text-muted-foreground">A whole number from 1 to {MAX_SIGN_HOURS}. Blank keeps the default. Requests already out keep their time.</span>
      </label>
      {owns ? <SubmitButton className="h-11 text-[13px] font-medium" pendingLabel="Saving…">Save signing</SubmitButton> : <p className="text-sm text-muted-foreground">Only an owner changes the time to sign.</p>}
    </form>
  );
}
