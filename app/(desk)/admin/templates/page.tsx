import Link from "next/link";
import { saveLegal } from "@/actions/legal";
import { saveTemplate } from "@/actions/templates";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { SubmitButton } from "@/components/submit-button";
import { requireRole } from "@/lib/auth";
import { prettyDate, q } from "@/lib/format";
import { LEGAL_KEYS, LEGAL_PATHS, currentLegalVersion, loadLegal, nextLegalVersion } from "@/lib/legal";
import { loadTemplates } from "@/lib/templates";

export const metadata = { title: "Forms" };

export default async function TemplatesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireRole(["ADMIN"]);
  const params = await searchParams;
  const [templates, legal, version] = await Promise.all([loadTemplates(), Promise.all(LEGAL_KEYS.map((key) => loadLegal(key))), currentLegalVersion()]);
  return (
    <div>
      <PageIntro
        eyebrow="Forms"
        title="The paper that closes."
        lede="Purchase agreement, assignment, and allonge. Tokens such as {{buyer}}, {{seller}}, {{price}}, {{upb}}, {{street}}, and {{date}} fill from the deal."
      />
      <Notice notice={q(params, "notice")} error={q(params, "error")} />
      <div className="mt-8 space-y-6">
        {templates.map((template) => (
          <form key={template.key} action={saveTemplate} className="glass space-y-3 p-5">
            <p className="eyebrow">{template.key}</p>
            <input type="hidden" name="key" value={template.key} />
            <label className="block">
              <span className="text-[13px] text-muted-foreground">Title</span>
              <input name="title" defaultValue={template.title} className="desk-input mt-2" aria-label={`${template.key} title`} />
            </label>
            <label className="block">
              <span className="text-[13px] text-muted-foreground">Body</span>
              <textarea name="body" defaultValue={template.body} className="desk-input mt-2 min-h-48" aria-label={`${template.key} body`} />
            </label>
            <SubmitButton className="h-11 text-[13px] font-medium">Save form</SubmitButton>
          </form>
        ))}
      </div>

      <section className="mt-12" aria-labelledby="legal-heading">
        <h2 id="legal-heading" className="eyebrow">Terms and privacy</h2>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Public at <Link href="/terms" className="text-link">/terms</Link> and <Link href="/privacy" className="text-link">/privacy</Link>, and agreed to at sign-up. Accounts have accepted version {version}. Put a blank line between paragraphs, start a heading with ##, a list item with -, and the draft note with &gt;. {"{{retentionYears}}"} fills from the compliance settings and {"{{contact}}"} from the desk&apos;s email.
        </p>
        <div className="mt-6 space-y-6">
          {legal.map((doc) => (
            <form key={doc.key} action={saveLegal} className="glass space-y-3 p-5">
              <p className="eyebrow">
                {doc.key} · <Link href={LEGAL_PATHS[doc.key]} className="text-link normal-case">{LEGAL_PATHS[doc.key]}</Link>
                {doc.updatedAt ? ` · saved ${prettyDate(doc.updatedAt)}` : " · built-in draft"}
              </p>
              <input type="hidden" name="key" value={doc.key} />
              <label className="block">
                <span className="text-[13px] text-muted-foreground">Title</span>
                <input name="title" defaultValue={doc.title} className="desk-input mt-2" aria-label={`${doc.key} title`} />
              </label>
              <label className="block">
                <span className="text-[13px] text-muted-foreground">Body</span>
                <textarea name="body" defaultValue={doc.body} className="desk-input mt-2 min-h-96" aria-label={`${doc.key} body`} />
              </label>
              <label className="flex items-start gap-2.5 text-sm text-foreground">
                <input type="checkbox" name="reaccept" value="yes" className="mt-0.5 size-4 shrink-0 accent-link" />
                <span>
                  Ask every account to accept again
                  <span className="block text-xs text-muted-foreground">For a change that needs fresh consent. It raises the version to {nextLegalVersion(version)}, and every account sees a banner until they accept.</span>
                </span>
              </label>
              <SubmitButton className="h-11 text-[13px] font-medium">Save page</SubmitButton>
            </form>
          ))}
        </div>
      </section>
    </div>
  );
}
