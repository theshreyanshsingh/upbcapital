import Link from "next/link";
import { redirect } from "next/navigation";
import { deleteBuyerWebhook, redeliverBuyerWebhook, revokeBuyerKey, saveBuyerWebhookEvents } from "@/actions/buyer-api";
import { BuyerKeyForm, BuyerWebhookForm } from "@/components/buyer-api-forms";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { SubmitButton } from "@/components/submit-button";
import { BUYER_SCOPES, buyerApiProblem, buyerKeyProblem, proLapse, SCOPE_LABELS, scopesOf } from "@/lib/api-keys";
import { API_LIMIT } from "@/lib/api-limit";
import { requireRole } from "@/lib/auth";
import { q } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { canManageSeats } from "@/lib/seats";
import { BUYER_WEBHOOK_EVENTS, deliveryState, endpointEvents, webhookUrlProblem } from "@/lib/webhooks";

export const metadata = { title: "Buyer API" };

// Minutes matter for a retry, so the log shows the time in UTC as well as the day.
const stamp = (at: Date) => `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;

const TONE = { good: "text-foreground", waiting: "text-muted-foreground", bad: "text-bad" } as const;

export default async function BuyerApiPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireRole(["BUYER"]);
  if (user.accountStatus !== "APPROVED") redirect("/buyer/pending");
  const query = await searchParams;
  const [file, keys, hooks] = await Promise.all([
    prisma.buyerProfile.findUnique({ where: { userId: user.id }, select: { status: true } }),
    prisma.apiKey.findMany({ where: { userId: user.id }, orderBy: { createdAt: "desc" } }),
    prisma.webhookEndpoint.findMany({ where: { userId: user.id }, include: { deliveries: { orderBy: { createdAt: "desc" }, take: 10 } }, orderBy: { createdAt: "desc" } }),
  ]);
  // Pro runs the keys and the webhooks. A key minted under Pro is kept when Pro lapses, paused until it returns.
  const paused = buyerApiProblem(user);
  const mintBlock = buyerKeyProblem(user, file);
  // A key reads as the whole firm, so only the owner or a managing seat changes keys and webhooks.
  const manage = canManageSeats(user);
  return (
    <div>
      <PageIntro
        eyebrow="Buyer API"
        title="Read the book from your own systems."
        lede={`A Pro key reads live listings, your buy-box matches, your inquiries and your holdings, and webhooks tell you what changed. Each key may make ${API_LIMIT.requests} requests a minute.`}
      />
      <Notice notice={q(query, "notice")} error={q(query, "error")} />
      {paused ? (
        <section className="mt-6 max-w-2xl border border-border p-5 rounded-xl">
          <h2 className="text-[15px] font-semibold text-foreground">The buyer API is a Pro feature.</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {proLapse(user) ?? paused} Keys and webhooks work while the account has Pro, a trial included.
            {keys.some((key) => !key.revokedAt) ? " The keys below are paused until Pro is back." : ""}
          </p>
          <Link href="/buyer/subscription" className="mt-4 inline-flex h-10 items-center bg-primary px-4 text-[13px] font-medium text-primary-foreground rounded-lg">See Pro</Link>
        </section>
      ) : mintBlock ? (
        <p className="mt-6 max-w-2xl border border-border px-4 py-3 text-sm text-muted-foreground rounded-xl">{mintBlock}</p>
      ) : null}
      {!manage && <p className="mt-6 text-sm text-muted-foreground">Only a managing seat or the account owner can change keys and webhooks.</p>}
      <p className="mt-6 text-sm text-muted-foreground">
        Send the key as Authorization: Bearer upb_… . Endpoints, paging, scopes and event bodies are on <Link href="/developers" className="text-link">the developers page</Link>.
      </p>

      <h2 className="eyebrow mt-10">Keys</h2>
      {keys.length === 0 && <p className="mt-3 text-sm text-muted-foreground">No keys yet.</p>}
      <ul className="mt-3 space-y-3">
        {keys.map((key) => (
          <li key={key.id} className="flex items-center justify-between gap-3 border border-border px-4 py-3 text-sm rounded-xl">
            <span className="min-w-0">
              <span className="block text-foreground">{key.name} · {key.prefix}…</span>
              <span className="block text-xs text-muted-foreground">{scopesOf(key).join(", ") || "No scopes"}</span>
              <span className="block text-xs text-muted-foreground tabular-nums">
                {key.revokedAt ? `Revoked ${stamp(key.revokedAt)}` : key.lastUsedAt ? `Last used ${stamp(key.lastUsedAt)}` : "Not used yet"}
                {!key.revokedAt && paused ? " · paused" : ""}
              </span>
            </span>
            {!key.revokedAt && manage && (
              <form action={revokeBuyerKey}>
                <input type="hidden" name="id" value={key.id} />
                <SubmitButton variant="ghost" pendingLabel="Revoking…" className="h-8 text-[13px] font-medium">Revoke</SubmitButton>
              </form>
            )}
          </li>
        ))}
      </ul>
      {!mintBlock && manage && <BuyerKeyForm scopes={BUYER_SCOPES.map((scope) => ({ scope, label: SCOPE_LABELS[scope] }))} />}

      <h2 className="eyebrow mt-10">Webhooks</h2>
      <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
        Signed in x-upb-signature with the endpoint&apos;s secret. A failed delivery is tried again five times over the next day and a half.
      </p>
      {!paused && manage && <BuyerWebhookForm />}
      {hooks.length === 0 && <p className="mt-3 text-sm text-muted-foreground">No webhooks yet.</p>}
      <ul className="mt-4 space-y-3">
        {hooks.map((hook) => (
          <li key={hook.id} className="border border-border px-4 py-3 text-sm rounded-xl">
            <div className="flex items-center justify-between gap-3">
              <span className="min-w-0 break-all text-foreground">{hook.url}</span>
              {manage && (
                <form action={deleteBuyerWebhook}>
                  <input type="hidden" name="id" value={hook.id} />
                  <SubmitButton variant="ghost" className="h-8 text-[13px] font-medium">Remove</SubmitButton>
                </form>
              )}
            </div>
            {webhookUrlProblem(hook.url) && (
              <p className="mt-1 text-xs text-bad">This address can&apos;t receive webhooks: {webhookUrlProblem(hook.url)} Remove it and add an https URL on a public host.</p>
            )}
            <form action={saveBuyerWebhookEvents} className="mt-3">
              <input type="hidden" name="endpointId" value={hook.id} />
              <fieldset>
                <legend className="text-[13px] text-muted-foreground">Events sent here</legend>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {BUYER_WEBHOOK_EVENTS.map((item) => (
                    <label key={item.event} className="flex items-start gap-2 text-sm text-foreground">
                      <input type="checkbox" name="events" value={item.event} defaultChecked={endpointEvents(hook.events).includes(item.event)} disabled={!manage} className="mt-1" />
                      <span>{item.label} <span className="text-xs text-muted-foreground">{item.event}</span></span>
                    </label>
                  ))}
                </div>
              </fieldset>
              {manage && <SubmitButton variant="outline" pendingLabel="Saving…" className="mt-3 h-9 px-3 text-[13px] font-medium">Save events</SubmitButton>}
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
                    {delivery.payload && !paused && manage && (
                      <form action={redeliverBuyerWebhook}>
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
