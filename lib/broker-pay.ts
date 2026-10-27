import type { FeeBasis, BrokerDealRole } from "@prisma/client";
import { assessBrokerFees, type FeeTerms } from "@/lib/broker-fees";
import { postRevenueOnce } from "@/lib/ledger";
import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";

function termsOf(basis: FeeBasis | null | undefined, bps: number | null | undefined, cents: number | null | undefined): FeeTerms | null {
  if (!basis) return null;
  return { basis, bps: bps ?? 0, cents: cents ?? 0 };
}

function roleTerms(
  role: BrokerDealRole,
  profile: {
    brokerFeeBasis: FeeBasis | null;
    brokerFeeBps: number | null;
    brokerFeeCents: number | null;
    affiliateFeeBasis: FeeBasis | null;
    affiliateFeeBps: number | null;
    affiliateFeeCents: number | null;
  } | null,
) {
  if (!profile) return null;
  if (role === "AFFILIATE") return termsOf(profile.affiliateFeeBasis, profile.affiliateFeeBps, profile.affiliateFeeCents);
  return termsOf(profile.brokerFeeBasis, profile.brokerFeeBps, profile.brokerFeeCents);
}

export async function assessClosingById(closingId: string) {
  const closing = await prisma.closing.findUnique({
    where: { id: closingId },
    include: { listing: { include: { broker: { include: { brokerProfile: true } } } } },
  });
  if (!closing) return null;
  const settings = await getSettings();
  const inquiry = closing.inquiryId
    ? await prisma.inquiry.findUnique({
        where: { id: closing.inquiryId },
        include: { buyer: { include: { referredBy: { include: { brokerProfile: true } } } } },
      })
    : null;
  const broker = closing.listing.broker;
  const referrer = inquiry?.buyer.referredBy?.role === "BROKER" && inquiry.buyer.referredBy.accountStatus === "APPROVED"
    ? inquiry.buyer.referredBy
    : null;
  const deal = broker && closing.listing.brokerRole
    ? {
        brokerId: broker.id,
        role: closing.listing.brokerRole,
        terms: roleTerms(closing.listing.brokerRole, broker.brokerProfile),
      }
    : null;
  const result = assessBrokerFees({
    premiumCents: closing.buyerPremiumCents,
    commissionCents: closing.sellerCommissionCents,
    sellerId: closing.listing.sellerId,
    buyerId: inquiry?.buyerId ?? null,
    clientSellerName: closing.listing.clientSellerName,
    brokerName: broker?.name ?? "",
    deal,
    referrer: referrer
      ? { brokerId: referrer.id, terms: termsOf(referrer.brokerProfile?.affiliateFeeBasis, referrer.brokerProfile?.affiliateFeeBps, referrer.brokerProfile?.affiliateFeeCents) }
      : null,
    brokerSchedule: { basis: settings.brokerFeeBasis, bps: settings.brokerFeeBps, cents: settings.brokerFeeCents },
    affiliateSchedule: { basis: settings.affiliateFeeBasis, bps: settings.affiliateFeeBps, cents: settings.affiliateFeeCents },
  });
  const names = new Map<string, string>();
  if (broker) names.set(broker.id, broker.name);
  if (referrer) names.set(referrer.id, referrer.name);
  return { closing, result, names };
}

export async function postBrokerFees(closingId: string) {
  const assessed = await assessClosingById(closingId);
  if (!assessed) return;
  for (const fee of assessed.result.fees) {
    const existing = await prisma.brokerFee.findFirst({
      where: { closingId, brokerId: fee.brokerId, role: fee.role },
    });
    if (!existing) {
      await prisma.brokerFee.create({
        data: {
          closingId,
          brokerId: fee.brokerId,
          role: fee.role,
          amountCents: fee.amountCents,
          basis: fee.basis,
          status: "OWED",
        },
      });
    }
    const name = assessed.names.get(fee.brokerId) ?? "broker";
    await postRevenueOnce([
      {
        type: "BROKER_FEE",
        amountCents: fee.amountCents,
        listingId: assessed.closing.listingId,
        userId: fee.brokerId,
        description: `Broker fee owed to ${name}`,
        externalId: `closing:${closingId}:broker:${fee.brokerId}:${fee.role}`,
      },
    ]);
  }
}

export async function closingBrokerView(closingId: string) {
  const [posted, assessed] = await Promise.all([
    prisma.brokerFee.findMany({ where: { closingId }, include: { broker: true }, orderBy: { createdAt: "asc" } }),
    assessClosingById(closingId),
  ]);
  return {
    posted,
    preview: posted.length ? [] : assessed?.result.fees ?? [],
    withheld: assessed?.result.withheld ?? [],
    names: assessed?.names ?? new Map<string, string>(),
    attribution: assessed?.closing.listing.broker
      ? {
          name: assessed.closing.listing.broker.name,
          company: assessed.closing.listing.broker.companyName,
          role: assessed.closing.listing.brokerRole,
          client: assessed.closing.listing.clientSellerName,
        }
      : null,
  };
}
