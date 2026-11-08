import { prisma } from "@/lib/prisma";
import { INVOICE_KIND_LABELS, creditLeft } from "@/lib/invoices";
import { payoutLabel } from "@/lib/payout-accounts";
import { buyerDueCents, sellerNetCents, variance } from "@/lib/settlement";

// The desk's finance exports: closings, seller payouts, invoices, credit notes and revenue by month. The export
// route gates them to the desk book and the admin (app/api/admin/export/route.ts). Money is in dollars to the cent.

export const FINANCE_EXPORTS = ["closings", "payouts", "invoices", "credit-notes", "revenue"] as const;
export type FinanceExport = (typeof FINANCE_EXPORTS)[number];

export function isFinanceExport(kind: string): kind is FinanceExport {
  return (FINANCE_EXPORTS as readonly string[]).includes(kind);
}

type Row = Record<string, string | number | null>;

const usd = (cents: number | null | undefined) => (cents == null ? "" : Math.round(cents) / 100);
const day = (date: Date | null | undefined) => (date ? date.toISOString().slice(0, 10) : "");

async function emailsOf(ids: (string | null | undefined)[]) {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (!wanted.length) return new Map<string, { email: string; name: string }>();
  const users = await prisma.user.findMany({ where: { id: { in: wanted } }, select: { id: true, email: true, name: true } });
  return new Map(users.map((user) => [user.id, { email: user.email, name: user.name }]));
}

async function payoutAccountsOf(ids: (string | null | undefined)[]) {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (!wanted.length) return new Map<string, { bankName: string; accountLast4: string; status: string; verifiedAt: Date | null }>();
  const accounts = await prisma.payoutAccount.findMany({ where: { id: { in: wanted } } });
  return new Map(accounts.map((account) => [account.id, account]));
}

export async function financeRows(kind: FinanceExport): Promise<Row[]> {
  if (kind === "closings" || kind === "payouts") {
    const closings = await prisma.closing.findMany({
      where: kind === "payouts" ? { proceedsSentCents: { not: null } } : {},
      include: { listing: { select: { title: true, sellerId: true } } },
      orderBy: { openedAt: "desc" },
    });
    const inquiries = await prisma.inquiry.findMany({ where: { id: { in: closings.map((row) => row.inquiryId).filter((id): id is string => Boolean(id)) } }, select: { id: true, buyerId: true } });
    const buyerOf = new Map(inquiries.map((row) => [row.id, row.buyerId]));
    const people = await emailsOf([...closings.map((row) => row.listing.sellerId), ...inquiries.map((row) => row.buyerId)]);
    const accounts = await payoutAccountsOf(closings.map((row) => row.payoutAccountId));
    if (kind === "payouts") {
      return closings.map((row) => {
        const account = row.payoutAccountId ? accounts.get(row.payoutAccountId) : undefined;
        const check = variance(sellerNetCents(row), row.proceedsSentCents);
        return {
          closingId: row.id,
          listing: row.listing.title,
          seller: people.get(row.listing.sellerId)?.email ?? "",
          expected: usd(sellerNetCents(row)),
          sent: usd(row.proceedsSentCents),
          check: check.state,
          sentOn: day(row.proceedsSentAt),
          reference: row.proceedsReference ?? "",
          payoutAccount: account ? payoutLabel(account) : "",
          accountStatus: account?.status ?? "",
          verifiedOn: day(account?.verifiedAt),
        };
      });
    }
    return closings.map((row) => {
      const buyerId = row.inquiryId ? buyerOf.get(row.inquiryId) : null;
      const account = row.payoutAccountId ? accounts.get(row.payoutAccountId) : undefined;
      return {
        id: row.id,
        listing: row.listing.title,
        status: row.status,
        seller: people.get(row.listing.sellerId)?.email ?? "",
        buyer: row.deskBidId ? "UPB desk" : buyerId ? people.get(buyerId)?.email ?? "" : "",
        openedOn: day(row.openedAt),
        closedOn: day(row.closedAt),
        canceledOn: day(row.canceledAt),
        salePrice: Number(row.salePrice),
        buyerPremium: usd(row.buyerPremiumCents),
        sellerCommission: usd(row.sellerCommissionCents),
        cutoffDate: day(row.cutoffDate),
        proration: usd(row.prorationCents),
        buyerDue: usd(buyerDueCents(row)),
        sellerNet: usd(sellerNetCents(row)),
        depositReceived: usd(row.depositReceivedCents),
        fundsReceived: usd(row.fundsReceivedCents),
        proceedsSent: usd(row.proceedsSentCents),
        payoutAccount: account ? payoutLabel(account) : "",
      };
    });
  }
  if (kind === "invoices" || kind === "credit-notes") {
    const invoices = await prisma.invoice.findMany({ orderBy: { issuedAt: "desc" } });
    const people = await emailsOf(invoices.map((row) => row.userId));
    const byId = new Map(invoices.map((row) => [row.id, row]));
    const closingIds = [...new Set(invoices.map((row) => row.closingId).filter((id): id is string => Boolean(id)))];
    const titles = closingIds.length
      ? new Map((await prisma.closing.findMany({ where: { id: { in: closingIds } }, select: { id: true, listing: { select: { title: true } } } })).map((row) => [row.id, row.listing.title]))
      : new Map<string, string>();
    if (kind === "credit-notes") {
      return invoices
        .filter((row) => row.kind === "CREDIT_NOTE")
        .map((row) => ({
          number: row.number,
          issuedOn: day(row.issuedAt),
          against: row.creditOfId ? byId.get(row.creditOfId)?.number ?? "" : "",
          fee: row.creditOfId ? INVOICE_KIND_LABELS[byId.get(row.creditOfId)?.kind ?? ""] ?? "" : "",
          party: people.get(row.userId)?.email ?? "",
          closingId: row.closingId ?? "",
          listing: row.closingId ? titles.get(row.closingId) ?? "" : "",
          amount: usd(row.amountCents),
          description: row.description,
        }));
    }
    return invoices
      .filter((row) => row.kind !== "CREDIT_NOTE")
      .map((row) => {
        const credits = invoices.filter((credit) => credit.creditOfId === row.id);
        return {
          number: row.number,
          kind: INVOICE_KIND_LABELS[row.kind] ?? row.kind,
          issuedOn: day(row.issuedAt),
          party: people.get(row.userId)?.email ?? "",
          name: people.get(row.userId)?.name ?? "",
          closingId: row.closingId ?? "",
          listing: row.closingId ? titles.get(row.closingId) ?? "" : "",
          amount: usd(row.amountCents),
          credited: usd(-credits.reduce((sum, credit) => sum + credit.amountCents, 0)),
          net: usd(creditLeft(row, credits)),
          canceledOn: day(row.voidedAt),
        };
      });
  }
  return revenueByMonth();
}

// Revenue by calendar month (UTC), from the ledger. Credit notes post as negative ledger rows, so premiums and
// commissions are net of them; the credits column shows how much came back. Broker fees are owed to brokers, not
// the desk's income. Simulated checkout rows are left out, since no money moved.
export async function revenueByMonth(): Promise<Row[]> {
  const [events, credits] = await Promise.all([
    prisma.revenueEvent.findMany({ where: { mock: false }, orderBy: { occurredAt: "asc" } }),
    prisma.invoice.findMany({ where: { kind: "CREDIT_NOTE" }, select: { amountCents: true, issuedAt: true } }),
  ]);
  const months = new Map<string, { premiums: number; commissions: number; subscriptions: number; brokerFees: number; credits: number }>();
  const month = (date: Date) => {
    const key = date.toISOString().slice(0, 7);
    if (!months.has(key)) months.set(key, { premiums: 0, commissions: 0, subscriptions: 0, brokerFees: 0, credits: 0 });
    return months.get(key)!;
  };
  for (const event of events) {
    const row = month(event.occurredAt);
    if (event.type === "BUYER_PREMIUM") row.premiums += event.amountCents;
    else if (event.type === "SELLER_COMMISSION") row.commissions += event.amountCents;
    else if (event.type === "SUBSCRIPTION") row.subscriptions += event.amountCents;
    else if (event.type === "BROKER_FEE") row.brokerFees += event.amountCents;
  }
  for (const credit of credits) month(credit.issuedAt).credits += -credit.amountCents;
  return [...months.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, row]) => ({
      month: key,
      buyerPremiums: usd(row.premiums),
      sellerCommissions: usd(row.commissions),
      subscriptions: usd(row.subscriptions),
      creditNotes: usd(row.credits),
      brokerFeesOwed: usd(row.brokerFees),
      deskRevenue: usd(row.premiums + row.commissions + row.subscriptions - row.brokerFees),
    }));
}
