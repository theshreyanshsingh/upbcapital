import { deleteWebhook, redeliverWebhook, revokeApiKey, saveWebhookEvents } from "@/actions/keys";
import { MintKeyForm, WebhookForm } from "@/components/api-forms";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { SubmitButton } from "@/components/submit-button";
import { requireUser } from "@/lib/auth";
import { q } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { API_LIMIT } from "@/lib/api-limit";
import { deliveryState, endpointEvents, WEBHOOK_EVENTS, webhookUrlProblem } from "@/lib/webhooks";
import { redirect } from "next/navigation";

export const metadata = { title: "Seller API" };

// Minutes matter for a retry, so the log shows the time in UTC as well as the day.
const stamp = (at: Date) => `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;

const TONE = { good: "text-foreground", waiting: "text-muted-foreground", bad: "text-bad" } as const;

export default async function SellerApiPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireUser();
  if (user.role !== "INSTITUTIONAL_SELLER" && user.role !== "ADMIN") redirect("/");
  const query = await searchParams;
  const [keys, hooks] = await Promise.all([
    prisma.apiKey.findMany({ where: { userId: user.id }, orderBy: { createdAt: "desc" } }),
    prisma.webhookEndpoint.findMany({ where: { userId: user.id }, include: { deliveries: { orderBy: { createdAt: "desc" }, take: 10 } }, orderBy: { createdAt: "desc" } }),
  ]);
  return (
    <div>
      <PageIntro
        eyebrow="Institutional API"
        title="Push a tape. Pull the offers."
        lede={`Keys belong to this account. Send Authorization: Bearer upb_… . POST /api/v1/tapes with JSON { title, csv }. GET /api/v1/offers lists bids on your listings. Each key may make ${API_LIMIT.requests} requests a minute. Webhooks are signed in x-upb-signature, and a failed delivery is tried again five times over the next day and a half.`}
      />
      <Notice notice={q(query, "notice")} error={q(query, "error")} />
      <ul className="mt-8 space-y-3">
        {keys.map((key) => (
          <li key={key.id} className="flex items-center justify-between border border-border px-4 py-3 text-sm rounded-xl">
            <span className="text-foreground">{key.name} · {key.prefix}…</span>
            <form action={revokeApiKey}>
              <input type="hidden" name="id" value={key.id} />
              <SubmitButton variant="ghost" className="h-8 text-[13px] font-medium">Revoke</SubmitButton>
            </form>
          </li>
        ))}
      </ul>
      <MintKeyForm />
      <WebhookForm />
      <ul className="mt-4 space-y-3">
        {hooks.map((hook) => (
          <li key={hook.id} className="border border-border px-4 py-3 text-sm rounded-xl">
            <div className="flex items-center justify-between gap-3">
              <span className="min-w-0 break-all text-foreground">{hook.url}</span>
              <form action={deleteWebhook}>
                <input type="hidden" name="id" value={hook.id} />
                <SubmitButton variant="ghost" className="h-8 text-[13px] font-medium">Remove</SubmitButton>
              </form>
            </div>
            {/* Endpoints saved before the https and public-host rule would otherwise fail without a word. */}
            {webhookUrlProblem(hook.url) && (
              <p className="mt-1 text-xs text-bad">This address can&apos;t receive webhooks: {webhookUrlProblem(hook.url)} Remove it and add an https URL on a public host.</p>
            )}
            <form action={saveWebhookEvents} className="mt-3">
              <input type="hidden" name="endpointId" value={hook.id} />
              <fieldset>
                <legend className="text-[13px] text-muted-foreground">Events sent here</legend>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {WEBHOOK_EVENTS.map((item) => (
                    <label key={item.event} className="flex items-start gap-2 text-sm text-foreground">
                      <input type="checkbox" name="events" value={item.event} defaultChecked={endpointEvents(hook.events).includes(item.event)} className="mt-1" />
                      <span>{item.label} <span className="text-xs text-muted-foreground">{item.event}</span></span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <SubmitButton variant="outline" pendingLabel="Saving…" className="mt-3 h-9 px-3 text-[13px] font-medium">Save events</SubmitButton>
            </form>
            <p className="mt-4 text-[13px] text-muted-foreground">Recent deliveries</p>
            {hook.deliveries.length === 0 && <p className="mt-1 text-xs text-muted-foreground">Nothing sent yet.</p>}
            <ul className="mt-1 divide-y divide-border">
              {hook.deliveries.map((delivery) => {
                const state = deliveryState(delivery);
                return (
                  <li key={delivery.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <div className="min-w-0 text-xs">
                      <p className="text-foreground">{delivery.event} · {stamp(delivery.createdAt)}</p>
                      <p className={TONE[state.tone]}>
                        {state.label}
                        {state.tone === "waiting" && delivery.nextAttemptAt ? `, next at ${stamp(delivery.nextAttemptAt)}` : ""}
                        {state.tone !== "good" && delivery.detail ? ` · ${delivery.detail.slice(0, 120)}` : ""}
                      </p>
                    </div>
                    {delivery.payload && (
                      <form action={redeliverWebhook}>
                        <input type="hidden" name="deliveryId" value={delivery.id} />
                        <SubmitButton variant="ghost" pendingLabel="Sending…" className="h-8 text-[13px] font-medium">Redeliver</SubmitButton>
                      </form>
                    )}
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}
