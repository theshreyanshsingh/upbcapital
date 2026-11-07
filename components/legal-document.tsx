import Link from "next/link";
import { acceptLegal } from "@/actions/legal";
import { Notice } from "@/components/notice";
import { PublicPage } from "@/components/public-page";
import { SubmitButton } from "@/components/submit-button";
import { getCurrentUser } from "@/lib/auth";
import { prettyDate } from "@/lib/format";
import { LEGAL_VERSION, fillLegal, legalBlocks, legalContact, legalDue, legalLinkParts, loadLegal, type LegalKey } from "@/lib/legal";
import { homeFor } from "@/lib/labels";
import { getSettings } from "@/lib/settings";

function Linked({ text }: { text: string }) {
  return (
    <>
      {legalLinkParts(text).map((part, index) =>
        part.href ? <Link key={index} href={part.href} className="text-link">{part.text}</Link> : <span key={index}>{part.text}</span>,
      )}
    </>
  );
}

// The terms and the privacy policy share one version and one acceptance, which the terms page takes.
export async function LegalDocument({ legalKey, lede, notice, error }: { legalKey: LegalKey; lede: string; notice?: string; error?: string }) {
  const [doc, settings, user] = await Promise.all([loadLegal(legalKey), getSettings(), getCurrentUser()]);
  const version = settings.legalVersion || LEGAL_VERSION;
  const due = user ? legalDue(user, version) : false;
  const blocks = legalBlocks(fillLegal(doc.body, { retentionYears: settings.retentionYears, contact: legalContact() }));
  return (
    <PublicPage title={doc.title} lede={lede} authed={Boolean(user)}>
      <p className="text-sm text-muted-foreground">
        Version {version}
        {doc.updatedAt ? ` · updated ${prettyDate(doc.updatedAt)}` : ""}
        {user ? (
          <>
            {" · "}
            <Link href={homeFor(user.role)} className="text-link">Back to the desk</Link>
          </>
        ) : null}
      </p>
      <Notice notice={notice} error={error} />
      {due && (
        <p className="rounded-xl border border-link/30 bg-link/10 px-4 py-3 text-sm text-foreground">
          {legalKey === "TERMS" ? (
            <>Version {version} is waiting for your acceptance. <a href="#accept" className="text-link">Accept at the end of the page</a>.</>
          ) : (
            <>Version {version} is waiting for your acceptance. <Link href="/terms#accept" className="text-link">Accept on the terms page</Link>.</>
          )}
        </p>
      )}
      {blocks.map((block, index) => {
        if (block.kind === "heading") return <h2 key={index} className="pt-4 font-semibold tracking-tight text-2xl text-foreground">{block.text}</h2>;
        if (block.kind === "note") {
          return (
            <p key={index} role="note" className="rounded-xl border border-border bg-card px-4 py-3 text-sm font-medium text-foreground">
              <Linked text={block.text} />
            </p>
          );
        }
        if (block.kind === "list") {
          return (
            <ul key={index} className="list-disc space-y-1.5 pl-5">
              {block.items.map((item, itemIndex) => <li key={itemIndex}><Linked text={item} /></li>)}
            </ul>
          );
        }
        return <p key={index}><Linked text={block.text} /></p>;
      })}
      {user && legalKey === "TERMS" && (
        <section id="accept" className="glass scroll-mt-24 p-5" aria-labelledby="accept-heading">
          <h2 id="accept-heading" className="eyebrow">Your acceptance</h2>
          {due ? (
            <form action={acceptLegal} className="mt-3 space-y-3">
              <p className="text-sm text-muted-foreground">Accepting records version {version} of the terms of use and the privacy policy on your account, with today&apos;s date.</p>
              <SubmitButton className="h-11 px-5 text-[13px] font-medium" pendingLabel="Saving…">
                I accept the Terms of use and Privacy policy
              </SubmitButton>
            </form>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">
              You accepted version {user.termsVersion}{user.termsAcceptedAt ? ` on ${prettyDate(user.termsAcceptedAt)}` : ""}.
            </p>
          )}
        </section>
      )}
    </PublicPage>
  );
}
