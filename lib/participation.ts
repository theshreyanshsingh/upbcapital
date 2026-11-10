import { annualize, monthlyIrr, performingCase, projectFlows } from "@/lib/underwriting";

// Selling a slice of a note, or a partial position in one, waits on counsel's ruling on the open securities
// question. So do a group split into senior and junior slices, and the desk assigning outside investors' money to
// notes it bought. Until UPB_PARTICIPATIONS=1 is set, the model still splits the cash flows, but nothing fractional
// reaches the book.
export function participationsOpen(env: Record<string, string | undefined> = process.env) {
  return env.UPB_PARTICIPATIONS === "1";
}

export const PARTICIPATIONS_PAUSED = "Selling slices and partial positions is paused until counsel rules on it. You can still model a split.";

// Counsel: a fixed-yield senior slice sold to self-certified buyers is the part of a group furthest from a whole-note sale.
export const TRANCHES_PAUSED = "Groups split into senior and junior slices wait on counsel's review, so none can open or take new seats. A seat already pledged can still drop out.";

// The same pause, as the group form says it beside the choice it disables.
export const TRANCHES_FORM = "Senior and junior slices wait on counsel's review. Until then a group opens pro rata.";

// A senior and junior group can't open, take a seat or send its first offer while the freeze holds. A pro rata
// group, where every seat owns its percentage, stays open. A group already offered finishes as it stands.
export function trancheBlock(structure: string | null | undefined, env: Record<string, string | undefined> = process.env) {
  return structure === "SENIOR_JUNIOR" && !participationsOpen(env) ? TRANCHES_PAUSED : null;
}

// Counsel: whether the desk may take outside investors' money for its book at all, and under which exemption. The
// terms say UPB does not pool investors' money.
export const CAPITAL_PAUSED = "Assigning investors' capital to a desk note waits on counsel's review. Allocations already made, and the receipts they're owed, keep running.";

// New allocations only. Investors, commitments and the statements on existing allocations stay as they are.
export function capitalAllocationBlock(env: Record<string, string | undefined> = process.env) {
  return participationsOpen(env) ? null : CAPITAL_PAUSED;
}

// The FAQ's two answers that turn on the freeze (app/faq/page.tsx), so the public page says what the code does
// either way. Counsel: both answers, once the ruling is in.
export function participationFaq(open: boolean) {
  return {
    fund: open
      ? "No. Buyers bid on notes, alone or as a group that fills one listing. A group may split into a senior slice, paid first at a set yield, and a junior slice that takes the rest. The desk may also assign capital from its own investors to notes it buys for its book. There is no investor portal."
      : "No. Buyers bid on notes, alone or as a group that fills one listing, and each seat owns its percentage of the note. There is no waterfall and no investor portal.",
    resale: open
      ? "Yes. A partial position, such as a group seat, can be relisted. The new listing carries that share of the balance and the payment. A note you hold whole relists whole, and you can model a split on your portfolio."
      : "Not yet. Relisting a partial position, such as a group seat, is paused until counsel rules on it. A note you hold whole can be relisted, and you can still model a split on your portfolio.",
  };
}

// A holding of less than the whole note. A holding with no share recorded is the whole note.
export function partialShare(sharePercent: number | null | undefined) {
  if (sharePercent == null) return false;
  return sharePercent > 0 && sharePercent < 99.9;
}

export type SplitInput = {
  basis: number;
  upb: number;
  annualRate: number;
  monthlyPi: number;
  termMonths: number;
  percent: number;
  paymentCount: number | null;
  slicePrice: number;
};

export type SplitModel = {
  mode: "percent" | "payments";
  buyerMonthly: number;
  sellerMonthly: number;
  buyerIrr: number | null;
  sellerIrr: number | null;
  buyerUpb: number;
};

export function modelParticipation(input: SplitInput): SplitModel | null {
  if (input.basis <= 0 || input.upb <= 0 || input.slicePrice <= 0 || input.slicePrice >= input.basis) return null;
  if (input.percent <= 0 || input.percent > 100) return null;
  const term = Math.max(1, input.termMonths || 360);
  if (input.paymentCount != null) {
    if (input.paymentCount < 1 || input.paymentCount >= term) return null;
    const flows = projectFlows({
      bid: input.basis,
      upb: input.upb,
      annualRate: input.annualRate,
      monthlyPi: input.monthlyPi,
      termMonths: term,
    });
    const sold = flows.slice(1, input.paymentCount + 1);
    const kept = flows.slice(input.paymentCount + 1);
    if (!sold.length || !kept.length) return null;
    return {
      mode: "payments",
      buyerMonthly: sold[0] ?? 0,
      sellerMonthly: kept[0] ?? 0,
      buyerIrr: annualize(monthlyIrr([-input.slicePrice, ...sold])),
      sellerIrr: annualize(monthlyIrr([-(input.basis - input.slicePrice), ...kept])),
      buyerUpb: 0,
    };
  }
  const share = input.percent / 100;
  const buyer = performingCase({
    bid: input.slicePrice,
    upb: input.upb * share,
    annualRate: input.annualRate,
    monthlyPi: input.monthlyPi * share,
    termMonths: term,
  });
  const seller = performingCase({
    bid: input.basis - input.slicePrice,
    upb: input.upb * (1 - share),
    annualRate: input.annualRate,
    monthlyPi: input.monthlyPi * (1 - share),
    termMonths: term,
  });
  return {
    mode: "percent",
    buyerMonthly: input.monthlyPi * share,
    sellerMonthly: input.monthlyPi * (1 - share),
    buyerIrr: buyer.irrPct,
    sellerIrr: seller.irrPct,
    buyerUpb: input.upb * share,
  };
}
