import { createHmac } from "node:crypto";
import { prisma } from "@/lib/prisma";

export function signWebhook(secret: string, body: string) {
  return createHmac("sha256", secret).update(body).digest("hex");
}

export async function emitWebhook(userId: string, event: string, payload: Record<string, unknown>) {
  const endpoints = await prisma.webhookEndpoint.findMany({ where: { userId } });
  const body = JSON.stringify({ event, sentAt: new Date().toISOString(), ...payload });
  for (const endpoint of endpoints) {
    const allowed = endpoint.events.split(",").map((item) => item.trim());
    if (!allowed.includes(event)) continue;
    let status = 0;
    let detail = "";
    try {
      const response = await fetch(endpoint.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-upb-event": event,
          "x-upb-signature": signWebhook(endpoint.secret, body),
        },
        body,
        signal: AbortSignal.timeout(5000),
      });
      status = response.status;
      detail = (await response.text()).slice(0, 300);
    } catch (error) {
      detail = error instanceof Error ? error.message : "Delivery failed.";
    }
    await prisma.webhookDelivery.create({
      data: { endpointId: endpoint.id, event, status, detail },
    });
  }
}
