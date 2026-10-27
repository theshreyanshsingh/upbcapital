import { saveTemplate } from "@/actions/templates";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { SubmitButton } from "@/components/submit-button";
import { requireRole } from "@/lib/auth";
import { q } from "@/lib/format";
import { loadTemplates } from "@/lib/templates";

export const metadata = { title: "Forms" };

export default async function TemplatesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireRole(["ADMIN"]);
  const params = await searchParams;
  const templates = await loadTemplates();
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
    </div>
  );
}
