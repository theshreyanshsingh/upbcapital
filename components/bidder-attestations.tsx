import { giveBidderAttestation, revokeBidderAttestation, withdrawBidderAttestation } from "@/actions/attestations-bidder";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import {
  ATTESTATION_KEYS,
  attestationLabel,
  attestationState,
  attestationsOf,
  endings,
  kindOf,
  lastsLine,
  latestOf,
  sentenceLabel,
  stateLine,
  type AttestationKey,
} from "@/lib/attestations";
import { prettyDate } from "@/lib/format";
import { entityLabel } from "@/lib/labels";

// Bidder attestations (lib/attestations.ts): the buyer gives, renews and withdraws them per buying entity on their
// file, and the desk reads and revokes them on the buyer's page.

type FileRow = { id: string | null; name: string; entityType: string };

const STATE_TONE = { current: "text-good", expired: "text-bad", revoked: "text-muted-foreground", outdated: "text-bad" } as const;

export async function BuyerAttestations({ userId, files }: { userId: string; files: FileRow[] }) {
  const [rows, ended] = await Promise.all([attestationsOf(userId), endings(userId)]);
  const now = new Date();
  return (
    <section id="attestations" aria-labelledby="attestations-heading" className="mt-8 scroll-mt-6 rounded-xl border border-border p-4 sm:p-6">
      <p id="attestations-heading" className="eyebrow">Bidder statements</p>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        Some sales ask each bidder for a statement, such as an agency&apos;s bidder certification or a debt-buyer licence. Give it once for each buying entity, and it counts at every bid until it lapses, its wording changes or you withdraw it. Each one is kept with the exact wording you agreed to. The wording is UPB&apos;s draft; counsel, and an agency&apos;s own form where there is one, control.
      </p>
      <ul className="mt-4 space-y-4">
        {files.map((file) => (
          <li key={file.id ?? "main"} className="rounded-lg border border-border p-3 sm:p-4">
            <p className="break-words text-sm font-medium text-foreground">{file.name}</p>
            <p className="text-xs text-muted-foreground">{file.id ? entityLabel(file.entityType) : `Main buyer file · ${entityLabel(file.entityType).toLowerCase()}`}</p>
            <ul className="mt-3 divide-y divide-border">
              {ATTESTATION_KEYS.map((key) => {
                const latest = latestOf(rows, file.id, key);
                const state = latest ? attestationState(latest, now) : null;
                const kind = kindOf(key);
                return (
                  <li key={key} className="py-3 text-sm">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                      <p className="min-w-0 text-foreground">{kind.label}</p>
                      <p className={`text-[13px] font-medium ${state ? STATE_TONE[state] : "text-muted-foreground"}`}>{state === "current" ? "On file" : state === "expired" ? "Expired" : state === "outdated" ? "Wording changed" : state === "revoked" ? "Not current" : "Not given"}</p>
                    </div>
                    <p className="mt-1 break-words text-xs text-muted-foreground">
                      {latest ? stateLine(latest, now, ended.get(latest.id)) : lastsLine(kind)}
                      {latest?.reference ? ` · ${latest.reference}` : ""}
                    </p>
                    {state === "current" && latest ? (
                      <div className="mt-2">
                        <form action={withdrawBidderAttestation}>
                          <input type="hidden" name="attestationId" value={latest.id} />
                          <SubmitButton variant="ghost" pendingLabel="Withdrawing…" className="-ml-3 h-10 px-3 text-[13px] font-medium">Withdraw</SubmitButton>
                        </form>
                        {kind.months && <GiveForm kind={key} file={file} label="Renew it" />}
                      </div>
                    ) : (
                      <GiveForm kind={key} file={file} label={state === "expired" ? "Renew it" : state === "outdated" ? "Give it in the new wording" : "Give it"} />
                    )}
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}

// The wording in full, the reference the kind asks for, and the box that gives it.
function GiveForm({ kind: key, file, label }: { kind: AttestationKey; file: FileRow; label: string }) {
  const kind = kindOf(key);
  const fieldId = `reference-${key}-${file.id ?? "main"}`;
  return (
    <details className="mt-2 w-full">
      <summary className="flex min-h-10 cursor-pointer items-center text-[13px] font-medium text-link">{label}</summary>
      <form action={giveBidderAttestation} className="mt-2 space-y-3">
        <input type="hidden" name="kind" value={key} />
        <input type="hidden" name="buyerEntityId" value={file.id ?? ""} />
        <p className="rounded-lg border border-border bg-card px-3 py-2 text-xs leading-relaxed text-foreground">{kind.text}</p>
        <p className="text-xs text-muted-foreground">Version {kind.version}. {lastsLine(kind)}</p>
        {kind.reference && (
          <label className="block" htmlFor={fieldId}>
            <span className="text-[13px] text-muted-foreground">{kind.reference.label}</span>
            <Input id={fieldId} name="reference" required maxLength={44} placeholder={kind.reference.placeholder} className="mt-2 h-11 w-full bg-card" aria-describedby={`${fieldId}-help`} />
            <span id={`${fieldId}-help`} className="mt-1 block text-xs text-muted-foreground">{kind.reference.help}</span>
          </label>
        )}
        <label className="flex items-start gap-3 text-sm leading-relaxed text-muted-foreground">
          <input type="checkbox" name="agreed" value="yes" required className="mt-1 size-4 shrink-0" />
          <span className="min-w-0 break-words">I give this statement for {file.name}, and I may sign for it.</span>
        </label>
        <SubmitButton variant="outline" pendingLabel="Saving…" className="h-11 w-full text-[13px] font-medium sm:w-auto">Give the statement</SubmitButton>
      </form>
    </details>
  );
}

// Every statement the buyer gave, newest first, with the wording as given. Compliance revokes a current one with a
// reason the buyer reads.
export async function DeskAttestations({ userId, names, canRevoke }: { userId: string; names: Map<string, string>; canRevoke: boolean }) {
  const [rows, ended] = await Promise.all([attestationsOf(userId), endings(userId)]);
  const now = new Date();
  return (
    <section id="attestations" aria-labelledby="attestations-heading" className="mt-8 scroll-mt-6 rounded-xl border border-border p-4 sm:p-5">
      <p id="attestations-heading" className="eyebrow">Bidder statements</p>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">None given.</p>
      ) : (
        <ul className="mt-2 divide-y divide-border">
          {rows.map((row) => {
            const state = attestationState(row, now);
            const latest = latestOf(rows, row.buyerEntityId ?? null, row.kind)?.id === row.id;
            return (
              <li key={row.id} className="py-3 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <p className="min-w-0 font-medium text-foreground">{attestationLabel(row.kind)}</p>
                  <p className={`text-[13px] font-medium ${STATE_TONE[state]}`}>{state === "current" ? (latest ? "current" : "superseded") : state}</p>
                </div>
                <p className="break-words text-xs text-muted-foreground">
                  {names.get(row.buyerEntityId ?? "") ?? "Removed entity"} · version {row.version} · given {prettyDate(row.attestedAt)}
                  {row.attestedById !== userId ? " by a seat" : ""}
                  {row.expiresAt ? ` · until ${prettyDate(row.expiresAt)}` : ""}
                  {row.reference ? ` · ${row.reference}` : ""}
                </p>
                {state !== "current" && <p className="break-words text-xs text-muted-foreground">{stateLine(row, now, ended.get(row.id))}</p>}
                <details className="mt-1">
                  <summary className="flex min-h-10 cursor-pointer items-center text-[13px] font-medium text-link">Wording as given</summary>
                  <p className="mt-1 rounded-lg border border-border bg-card px-3 py-2 text-xs leading-relaxed text-foreground">{row.text}</p>
                </details>
                {canRevoke && state === "current" && latest && (
                  <form action={revokeBidderAttestation} className="mt-2 flex flex-wrap items-end gap-2">
                    <input type="hidden" name="attestationId" value={row.id} />
                    <input type="hidden" name="userId" value={userId} />
                    <label className="block w-full min-w-0 sm:w-auto sm:min-w-56 sm:flex-1">
                      <span className="text-xs text-muted-foreground">Why the desk is revoking it</span>
                      <input name="reason" required minLength={3} maxLength={300} className="desk-input mt-1" />
                    </label>
                    <ConfirmSubmit
                      title={`Revoke the ${sentenceLabel(row.kind)}?`}
                      consequence="It stops counting at once. Sales that ask for it take no new bid for this entity until the buyer gives it again. Bids already in stay. The buyer reads your reason, and it goes in the audit log."
                      typed={[["Reason", "reason", "text"]]}
                      confirmLabel="Revoke it"
                      pendingLabel="Revoking…"
                      variant="outline"
                      tone="danger"
                      className="h-10 w-full text-[13px] font-medium sm:w-auto"
                    >
                      Revoke
                    </ConfirmSubmit>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
