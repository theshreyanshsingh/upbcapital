import Link from "next/link";
import { signMasterAgreement } from "@/actions/agreements";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { SubmitButton } from "@/components/submit-button";
import { MASTER_LABELS, acceptanceHistory, agreementBack, currentAcceptance, masterKindsFor, masterLabel, masterPrefill, masterText } from "@/lib/agreements";
import { requireUser } from "@/lib/auth";
import { prettyDate, q } from "@/lib/format";
import { legalBlocks, legalLinkParts } from "@/lib/legal";

export const metadata = { title: "Agreements" };

export default async function AgreementsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const back = agreementBack(q(params, "back"));
  const kinds = await masterKindsFor(user);
  const rows = await Promise.all(
    kinds.map(async (kind) => {
      const [current, history, prefill] = await Promise.all([currentAcceptance(user.id, kind), acceptanceHistory(user.id, kind), masterPrefill(user, kind)]);
      return { kind, text: masterText(kind)!, current, earlier: history.filter((row) => row.id !== current?.id), prefill };
    }),
  );
  return (
    <div className="max-w-3xl">
      <PageIntro
        eyebrow="Agreements"
        title="Sign once for every sale."
        lede="Buyers sign the master purchase agreement and sellers the master sale agreement. When both sides of a sale have signed the current versions, its purchase agreement incorporates them by reference. Until then, the purchase agreement's own articles govern."
      />
      <Notice notice={q(params, "notice")} error={q(params, "error")} />
      {back && (
        <Link href={back} className="text-[13px] font-medium text-link">
          Back to where you were
        </Link>
      )}
      {kinds.length === 0 && <p className="mt-6 text-sm text-muted-foreground">No master agreement applies to this account. Buyers and sellers each sign one.</p>}
      {rows.map((row) => {
        const label = masterLabel(row.kind);
        return (
          <section key={row.kind} id={row.kind.toLowerCase()} aria-labelledby={`${row.kind}-heading`} className="glass mt-8 scroll-mt-6 p-5 sm:p-6">
            <p className="eyebrow">Version {row.text.version}</p>
            <h2 id={`${row.kind}-heading`} className="mt-1 font-semibold tracking-tight text-2xl text-foreground">{MASTER_LABELS[row.kind]}</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {row.current
                ? `You signed version ${row.current.version} on ${prettyDate(row.current.acceptedAt)} as ${row.current.signerName}${row.current.signerTitle ? `, ${row.current.signerTitle}` : ""}, for ${row.current.entityName}.`
                : row.earlier.length
                  ? `Version ${row.text.version} replaces the version ${row.earlier[0].version} you signed. Read it and sign again.`
                  : "Waiting for your signature."}
            </p>
            <AgreementText body={row.text.body} label={MASTER_LABELS[row.kind]} />
            {row.earlier.length > 0 && (
              <div className="mt-5">
                <p className="text-[13px] font-medium text-foreground">Signed before</p>
                <ul className="mt-2 divide-y divide-border border-y border-border">
                  {row.earlier.map((acceptance) => {
                    const text = acceptance.version === row.text.version ? null : masterText(row.kind, acceptance.version);
                    return (
                      <li key={acceptance.id} className="py-3">
                        <p className="text-sm text-foreground">
                          Version {acceptance.version} · {prettyDate(acceptance.acceptedAt)}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {acceptance.signerName}
                          {acceptance.signerTitle ? `, ${acceptance.signerTitle}` : ""}, for {acceptance.entityName}
                        </p>
                        {text && (
                          <details className="mt-2">
                            <summary className="cursor-pointer text-[13px] font-medium text-link">Read version {acceptance.version}</summary>
                            <AgreementText body={text.body} label={`${MASTER_LABELS[row.kind]}, version ${acceptance.version}`} />
                          </details>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
            {!row.current && (
              <form action={signMasterAgreement} className="mt-6 space-y-4">
                <input type="hidden" name="kind" value={row.kind} />
                {back && <input type="hidden" name="back" value={back} />}
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="block sm:col-span-2">
                    <span className="text-[13px] text-muted-foreground">Your legal name</span>
                    <input name="signerName" defaultValue={row.prefill.signerName} required minLength={2} maxLength={120} autoComplete="name" className="desk-input mt-2" />
                  </label>
                  <label className="block">
                    <span className="text-[13px] text-muted-foreground">Title</span>
                    <input name="signerTitle" defaultValue={row.prefill.signerTitle} maxLength={120} placeholder="Managing member, trustee" className="desk-input mt-2" />
                    <span className="mt-1 block text-xs text-muted-foreground">Leave it blank when you sign for yourself.</span>
                  </label>
                  <label className="block">
                    <span className="text-[13px] text-muted-foreground">Entity</span>
                    <input name="entityName" defaultValue={row.prefill.entityName} maxLength={160} autoComplete="organization" className="desk-input mt-2" />
                    <span className="mt-1 block text-xs text-muted-foreground">The company, trust or fund you sign for, or your own name.</span>
                  </label>
                </div>
                <label className="flex items-start gap-2.5 text-sm text-foreground">
                  <input type="checkbox" name="agreed" value="yes" required className="mt-0.5 size-4 shrink-0 accent-link" />
                  <span>I have read the {label}. I agree to it for the entity above, and I intend this typed name to be my electronic signature.</span>
                </label>
                <p className="text-xs text-muted-foreground">The desk records the version, your name, title and entity, the time, and the network address and device of this request.</p>
                <SubmitButton className="h-11 px-5 text-[13px] font-medium" pendingLabel="Signing…">
                  Sign the {label}
                </SubmitButton>
              </form>
            )}
          </section>
        );
      })}
    </div>
  );
}

// The agreement as the desk writes legal text: "## " headings, "- " lists and a "> " draft note, in a box that
// scrolls so the form stays close.
function AgreementText({ body, label }: { body: string; label: string }) {
  return (
    <div role="region" aria-label={label} tabIndex={0} className="mt-4 max-h-[28rem] space-y-3 overflow-y-auto rounded-xl border border-border bg-card p-4 text-sm leading-relaxed text-foreground sm:p-5">
      {legalBlocks(body).map((block, index) => {
        if (block.kind === "heading") return <h3 key={index} className="pt-2 font-semibold text-foreground">{block.text}</h3>;
        if (block.kind === "note") return <p key={index} role="note" className="rounded-lg border border-border bg-muted/60 px-3 py-2 font-medium">{block.text}</p>;
        if (block.kind === "list") {
          return (
            <ul key={index} className="list-disc space-y-1 pl-5">
              {block.items.map((item, itemIndex) => <li key={itemIndex}><Linked text={item} /></li>)}
            </ul>
          );
        }
        return <p key={index}><Linked text={block.text} /></p>;
      })}
    </div>
  );
}

function Linked({ text }: { text: string }) {
  return (
    <>
      {legalLinkParts(text).map((part, index) =>
        part.href ? <Link key={index} href={part.href} className="text-link">{part.text}</Link> : <span key={index}>{part.text}</span>,
      )}
    </>
  );
}
