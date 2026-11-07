import Link from "next/link";
import { saveLegal } from "@/actions/legal";
import { resetTemplate, saveTemplate } from "@/actions/templates";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { SubmitButton } from "@/components/submit-button";
import { requireRole } from "@/lib/auth";
import { DEFAULT_TEMPLATES, TEMPLATE_KEYS, templateTokens } from "@/lib/closing-docs";
import { prettyDate, q } from "@/lib/format";
import { LEGAL_KEYS, LEGAL_PATHS, currentLegalVersion, loadLegal, nextLegalVersion } from "@/lib/legal";
import { deskCan } from "@/lib/staff";
import { loadTemplates } from "@/lib/templates";

export const metadata = { title: "Forms" };

export default async function TemplatesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Every desk role reads the forms and legal texts. Only an owner edits them, and the actions check the same. The
  // content role may put a form back to its built-in text.
  const viewer = await requireRole(["ADMIN"]);
  const owns = deskCan(viewer, "admin");
  const resets = deskCan(viewer, "content");
  const params = await searchParams;
  const [templates, legal, version] = await Promise.all([loadTemplates(), Promise.all(LEGAL_KEYS.map((key) => loadLegal(key))), currentLegalVersion()]);
  const plain = (text: string) => text.replace(/\r\n/g, "\n").trim();
  return (
    <div>
      <PageIntro
        eyebrow="Forms"
        title="The paper that closes."
        lede="Purchase agreement, assignment, allonge, lost note affidavit and deposit agreement. Tokens such as {{buyer}}, {{seller}}, {{price}}, {{upb}}, {{street}} and {{date}} fill from the deal. {{masterTerms}} says whether the parties' master agreements are incorporated."
      />
      <Notice notice={q(params, "notice")} error={q(params, "error")} />
      {!owns && <p className="mt-4 text-sm text-muted-foreground">Your desk role reads these. Only an owner changes them.</p>}
      <div className="mt-8 space-y-6">
        {templates.map((template, index) => {
          const builtIn = DEFAULT_TEMPLATES[TEMPLATE_KEYS[index]];
          const edited = plain(template.title) !== builtIn.title || plain(template.body) !== builtIn.body;
          return (
            <div key={template.key} className="glass space-y-3 p-5">
              <p className="eyebrow">{template.key} · {edited ? "saved by the desk" : "built-in form"}</p>
              {owns ? (
                <form action={saveTemplate} className="space-y-3">
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
              ) : (
                <>
                  <p className="font-medium text-foreground">{template.title}</p>
                  <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">{template.body}</p>
                </>
              )}
              <p className="text-xs text-muted-foreground">Built-in tokens: {templateTokens(builtIn.body).map((token) => `{{${token}}}`).join(", ")}</p>
              {resets && edited && (
                <form action={resetTemplate}>
                  <input type="hidden" name="key" value={template.key} />
                  <ConfirmSubmit
                    title={`Put the built-in ${builtIn.title.toLowerCase()} back?`}
                    consequence="The saved text is replaced with the current built-in form. Closings download the built-in text from now on. The change is in the audit log."
                    confirmLabel="Use the built-in form"
                    pendingLabel="Resetting…"
                    variant="outline"
                    className="h-9 text-[13px] font-medium"
                  >
                    Reset to the built-in form
                  </ConfirmSubmit>
                </form>
              )}
            </div>
          );
        })}
      </div>

      <section className="mt-12" aria-labelledby="legal-heading">
        <h2 id="legal-heading" className="eyebrow">Terms and privacy</h2>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Public at <Link href="/terms" className="text-link">/terms</Link> and <Link href="/privacy" className="text-link">/privacy</Link>, and agreed to at sign-up. Accounts have accepted version {version}. Put a blank line between paragraphs, start a heading with ##, a list item with -, and the draft note with &gt;. {"{{retentionYears}}"} fills from the compliance settings and {"{{contact}}"} from the desk&apos;s email.
        </p>
        <div className="mt-6 space-y-6">
          {legal.map((doc) => owns ? (
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
          ) : (
            <article key={doc.key} className="glass space-y-3 p-5">
              <p className="eyebrow">
                {doc.key} · <Link href={LEGAL_PATHS[doc.key]} className="text-link normal-case">{LEGAL_PATHS[doc.key]}</Link>
                {doc.updatedAt ? ` · saved ${prettyDate(doc.updatedAt)}` : " · built-in draft"}
              </p>
              <p className="font-medium text-foreground">{doc.title}</p>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
