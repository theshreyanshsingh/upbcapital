import { deleteWebhook, revokeApiKey } from "@/actions/keys";
import { MintKeyForm, WebhookForm } from "@/components/api-forms";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { SubmitButton } from "@/components/submit-button";
import { requireUser } from "@/lib/auth";
import { q } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";

export const metadata = { title: "Seller API" };

export default async function SellerApiPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireUser();
  if (user.role !== "INSTITUTIONAL_SELLER" && user.role !== "ADMIN") redirect("/");
  const query = await searchParams;
  const [keys, hooks] = await Promise.all([
    prisma.apiKey.findMany({ where: { userId: user.id }, orderBy: { createdAt: "desc" } }),
    prisma.webhookEndpoint.findMany({ where: { userId: user.id }, include: { deliveries: { orderBy: { createdAt: "desc" }, take: 3 } }, orderBy: { createdAt: "desc" } }),
  ]);
  return (
    <div>
      <PageIntro
        eyebrow="Institutional API"
        title="Push a tape. Pull the offers."
        lede="Keys belong to this account. Send Authorization: Bearer upb_… . POST /api/v1/tapes with JSON { title, csv }. GET /api/v1/offers lists bids on your listings. Webhooks fire for offer.created, offer.accepted, offer.declined, and offer.countered, signed in x-upb-signature."
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
              <span className="text-foreground">{hook.url}</span>
              <form action={deleteWebhook}>
                <input type="hidden" name="id" value={hook.id} />
                <SubmitButton variant="ghost" className="h-8 text-[13px] font-medium">Remove</SubmitButton>
              </form>
            </div>
            <p className="mt-2 text-muted-foreground">{hook.events}</p>
            {hook.deliveries.map((delivery) => (
              <p key={delivery.id} className="mt-1 text-xs text-muted-foreground">{delivery.event} · {delivery.status || "failed"}</p>
            ))}
          </li>
        ))}
      </ul>
    </div>
  );
}
