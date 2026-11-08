import { redirect } from "next/navigation";
import { saveWidgetSettings } from "@/actions/broker-widget";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { SubmitButton } from "@/components/submit-button";
import { WidgetSnippet } from "@/components/widget-snippet";
import { requireRole } from "@/lib/auth";
import { brokerGate } from "@/lib/broker-fees";
import { MAX_WIDGET_ORIGINS, widgetSnippet, widgetUrl } from "@/lib/broker-widget";
import { money, prettyDate, q } from "@/lib/format";
import { labelOf } from "@/lib/labels";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Intake form" };

export default async function BrokerWidgetPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireRole(["BROKER"]);
  const profile = await prisma.brokerProfile.findUnique({ where: { userId: user.id } });
  const next = brokerGate({ accountStatus: user.accountStatus, profile });
  if (next) redirect(next);
  const params = await searchParams;
  const approved = user.accountStatus === "APPROVED";
  const code = user.referralCode || "";
  const leads = await prisma.sellerLead.findMany({ where: { brokerId: user.id }, orderBy: { createdAt: "desc" }, take: 100 });
  const origins = profile?.widgetOrigins ?? [];
  const live = Boolean(profile?.widgetEnabled && origins.length && code);
  return (
    <div className="max-w-3xl">
      <PageIntro
        eyebrow="Broker desk"
        title="An intake form for your site."
        lede="Sellers on your site get the desk's indicative range, and each lead is filed to you. The form shows only on the sites you list."
      />
      <Notice notice={q(params, "notice")} error={q(params, "error")} />
      {!approved || !code ? (
        <p className="mt-6 text-sm text-muted-foreground">The form opens when the desk approves your seat.</p>
      ) : (
        <>
          <form action={saveWidgetSettings} className="glass mt-6 space-y-5 p-6">
            <label className="flex items-center gap-3 text-sm text-foreground">
              <input type="checkbox" name="widgetEnabled" value="on" defaultChecked={profile?.widgetEnabled === true} />
              Turn the form on
            </label>
            <label className="block">
              <span className="text-[13px] text-muted-foreground">Sites that may show it</span>
              <textarea name="widgetOrigins" defaultValue={origins.join("\n")} placeholder="https://www.yourfirm.com" className="desk-input mt-2 min-h-24 font-mono text-[13px]" />
              <span className="mt-1 block text-xs text-muted-foreground">
                One per line, up to {MAX_WIDGET_ORIGINS}. Each starts with https, with nothing after the site name. Any other site sees a blank frame.
              </span>
            </label>
            <SubmitButton className="h-11 text-[13px] font-medium" pendingLabel="Saving…">Save</SubmitButton>
          </form>

          <section className="glass mt-6 p-6">
            <p className="eyebrow">Embed</p>
            {live ? (
              <>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">Paste this where the form should go on your site.</p>
                <div className="mt-4">
                  <WidgetSnippet snippet={widgetSnippet(code)} />
                </div>
                <a href={widgetUrl(code)} target="_blank" rel="noopener" className="mt-4 inline-block text-[13px] font-medium text-link">
                  Open the form
                </a>
              </>
            ) : (
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">Turn the form on and list a site to get the snippet.</p>
            )}
          </section>
        </>
      )}

      <section className="mt-10">
        <p className="eyebrow">Leads from the form</p>
        <ul className="mt-3 divide-y divide-border rounded-xl border border-border">
          {leads.length === 0 && <li className="px-5 py-8 text-sm text-muted-foreground">No leads yet. They show here, and on the desk, as sellers ask for a range.</li>}
          {leads.map((lead) => (
            <li key={lead.id} className="grid gap-2 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-baseline">
              <div className="min-w-0">
                <p className="text-foreground">{lead.name}</p>
                <p className="mt-0.5 break-all text-xs text-muted-foreground">
                  {lead.email}{lead.phone ? ` · ${lead.phone}` : ""}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {lead.city ? `${lead.city}, ` : ""}{lead.state} · {labelOf("lien", lead.lienPosition)} · {labelOf("payment", lead.paymentStatus)} · {money(Number(lead.indicativeLow))} – {money(Number(lead.indicativeHigh))} on {money(Number(lead.upb))} UPB
                </p>
              </div>
              <p className="text-xs text-muted-foreground">{prettyDate(lead.createdAt)} · {lead.status.toLowerCase()}</p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
