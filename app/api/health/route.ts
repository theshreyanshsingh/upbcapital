import { prisma } from "@/lib/prisma";
import { resolveMailTransport } from "@/lib/mail-config";
import { limitStore } from "@/lib/rate-limit";
import { storageMode } from "@/lib/storage";
import { aiMode } from "@/lib/desk-ai";
import { kycMode, signatureMode } from "@/lib/vendors";
import { ofacMode } from "@/lib/ofac";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  let db: "ok" | "down" = "ok";
  try {
    await prisma.$runCommandRaw({ ping: 1 });
  } catch {
    db = "down";
  }
  const body = {
    ok: db === "ok",
    db,
    storage: storageMode(),
    mail: resolveMailTransport(),
    stripe: Boolean(process.env.STRIPE_SECRET_KEY),
    escrow: process.env.ESCROW_PROVIDER || "manual",
    limits: limitStore(),
    avm: process.env.AVM_PROVIDER || "mock",
    signature: signatureMode(),
    kyc: kycMode(),
    assistant: aiMode(),
    ofac: ofacMode(),
    time: new Date().toISOString(),
  };
  return Response.json(body, { status: db === "ok" ? 200 : 503 });
}
