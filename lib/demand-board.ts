import { regionOf } from "@/lib/comps";
import { unset } from "@/lib/db-filters";
import { parseList } from "@/lib/buy-box";
import { LIEN_POSITIONS, PAYMENT_STATUSES } from "@/lib/labels";
import { prisma } from "@/lib/prisma";

// The public "who's buying" board: how many approved buyer firms have an active buy box that takes each kind of
// paper, by lien and performance and by Census region, and how many of those firms have a standing bid rule on it.
//
// Why counts are safe where lib/valuations.ts keeps standing demand off the public range. What that comment protects
// is the buyers' prices: a standing bid rule is a buyer's own price for paper (a percent of UPB, a yield or a
// spread), and folding it into a public range would publish it, or let anyone work it back out by sending loans. This
// board reads no price, yield, spread, cap, balance or LTV limit, and names no buyer, box or entity: it counts how
// many distinct firms' boxes cover a lien, a performance or a region. A count under three is withheld, so no cell can
// point at one buyer, or at two who can each subtract themselves and read the other. With three or more, a buyer who
// knows their own box still can't tell which of the others are there or what they pay. A count moves when a box is
// added or paused, and nothing says whose.

export const MIN_FIRMS = 3;
export const REGIONS = ["Northeast", "Midwest", "South", "West"] as const;
export const HIDDEN_LINE = "Fewer than 3 buyers: not shown";

// A box as the board reads it: whose firm, what it covers, and whether it has a standing bid rule. Nothing else.
export type DemandBox = { firm: string; states: string[]; liens: string[]; statuses: string[]; standing: boolean };

// Firms in a cell, or null when fewer than MIN_FIRMS distinct firms are there. Standing is held back on its own count.
export type DemandCell = { buyers: number | null; standing: number | null };

export type DemandBoard = {
  asOf: Date;
  total: DemandCell;
  liens: { value: string; label: string; cells: { value: string; label: string; cell: DemandCell }[] }[];
  regions: { region: string; cell: DemandCell }[];
};

function shown(count: number) {
  return count >= MIN_FIRMS ? count : null;
}

function cellOf(boxes: DemandBox[]): DemandCell {
  return { buyers: shown(new Set(boxes.map((box) => box.firm)).size), standing: shown(new Set(boxes.filter((box) => box.standing).map((box) => box.firm)).size) };
}

// An empty list in a box means it takes any, as matching reads it (lib/buy-box.ts).
const takes = (list: string[], value: string) => !list.length || list.includes(value);

export function demandBoard(boxes: DemandBox[], now = new Date()): DemandBoard {
  return {
    asOf: now,
    total: cellOf(boxes),
    liens: LIEN_POSITIONS.map((lien) => ({
      value: lien.value,
      label: lien.label,
      cells: PAYMENT_STATUSES.map((status) => ({
        value: status.value,
        label: status.label,
        cell: cellOf(boxes.filter((box) => takes(box.liens, lien.value) && takes(box.statuses, status.value))),
      })),
    })),
    regions: REGIONS.map((region) => ({ region, cell: cellOf(boxes.filter((box) => !box.states.length || box.states.some((state) => regionOf(state) === region))) })),
  };
}

// Active boxes of approved buyers. A firm's seats act for the firm's account, so a firm counts once however many
// people or boxes it has. Only the fields the board counts are read.
export async function loadDemandBoxes(): Promise<DemandBox[]> {
  const boxes = await prisma.buyBox.findMany({ where: { active: true }, select: { userId: true, states: true, liens: true, statuses: true, standingBids: true } });
  if (!boxes.length) return [];
  const owners = await prisma.user.findMany({
    where: { id: { in: [...new Set(boxes.map((box) => box.userId))] }, role: "BUYER", accountStatus: "APPROVED", ...unset("deletedAt") },
    select: { id: true, principalId: true },
  });
  const firmOf = new Map(owners.map((owner) => [owner.id, owner.principalId || owner.id]));
  return boxes.flatMap((box) => {
    const firm = firmOf.get(box.userId);
    return firm ? [{ firm, states: parseList(box.states), liens: parseList(box.liens), statuses: parseList(box.statuses), standing: box.standingBids === true }] : [];
  });
}

export async function currentDemandBoard(now = new Date()) {
  return demandBoard(await loadDemandBoxes(), now);
}
