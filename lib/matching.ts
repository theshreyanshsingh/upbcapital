import { parseList, scoreAgainstBox, type BoxCriteria, type ScoreNote } from "@/lib/buy-box";
import { notify } from "@/lib/email";
import { prisma } from "@/lib/prisma";

type BoxRow = {
  id: string;
  userId: string;
  name: string;
  states: string;
  liens: string;
  statuses: string;
  upbMin: { toString(): string } | null;
  upbMax: { toString(): string } | null;
  priceMin: { toString(): string } | null;
  priceMax: { toString(): string } | null;
  maxPriceToUpb: { toString(): string } | null;
  targetYield: { toString(): string } | null;
  active: boolean;
  user: { email: string; role: string; accountStatus: string };
};

function num(value: { toString(): string } | null) {
  if (value == null) return null;
  const parsed = Number(value.toString());
  return Number.isFinite(parsed) ? parsed : null;
}

export function criteriaFrom(box: {
  states: string;
  liens: string;
  statuses: string;
  upbMin: { toString(): string } | null;
  upbMax: { toString(): string } | null;
  priceMin: { toString(): string } | null;
  priceMax: { toString(): string } | null;
  maxPriceToUpb: { toString(): string } | null;
  targetYield: { toString(): string } | null;
}): BoxCriteria {
  return {
    states: parseList(box.states),
    liens: parseList(box.liens),
    statuses: parseList(box.statuses),
    upbMin: num(box.upbMin),
    upbMax: num(box.upbMax),
    priceMin: num(box.priceMin),
    priceMax: num(box.priceMax),
    maxPriceToUpb: num(box.maxPriceToUpb),
    targetYield: num(box.targetYield),
  };
}

function notesOf(notes: { state: string; lienPosition: string; paymentStatus: string; upb: { toString(): string }; askingPrice: { toString(): string }; monthlyPi: { toString(): string }; interestRate: { toString(): string }; maturityDate: Date | null }[]): ScoreNote[] {
  return notes.map((note) => {
    const months = note.maturityDate ? Math.round((note.maturityDate.getTime() - Date.now()) / (86400000 * 30)) : 360;
    return {
      state: note.state,
      lienPosition: note.lienPosition,
      paymentStatus: note.paymentStatus,
      upb: Number(note.upb),
      askingPrice: Number(note.askingPrice),
      monthlyPi: Number(note.monthlyPi),
      interestRate: Number(note.interestRate),
      termMonths: Math.min(480, Math.max(12, months)),
    };
  });
}

async function writeMatch(listingId: string, box: BoxRow, notes: ScoreNote[]) {
  const result = scoreAgainstBox(notes, criteriaFrom(box));
  if (!result) {
    await prisma.listingMatch.deleteMany({ where: { listingId, buyBoxId: box.id } });
    return null;
  }
  await prisma.listingMatch.upsert({
    where: { listingId_buyBoxId: { listingId, buyBoxId: box.id } },
    create: { listingId, buyBoxId: box.id, userId: box.userId, score: result.score, reasons: result.reasons.join(" · ") },
    update: { score: result.score, reasons: result.reasons.join(" · "), userId: box.userId },
  });
  return result;
}

export async function rescoreListing(listingId: string, alert: boolean) {
  const listing = await prisma.listing.findUnique({ where: { id: listingId }, include: { notes: true } });
  if (!listing || listing.status === "REJECTED") return;
  const boxes = await prisma.buyBox.findMany({ where: { active: true }, include: { user: true } });
  const notes = notesOf(listing.notes);
  const mailed = new Map<string, { email: string; score: number; name: string }>();
  for (const box of boxes) {
    const result = await writeMatch(listing.id, box, notes);
    if (!result || !alert || listing.status !== "APPROVED") continue;
    if (box.user.role !== "BUYER" || box.user.accountStatus !== "APPROVED") continue;
    const prior = mailed.get(box.userId);
    if (!prior || result.score > prior.score) mailed.set(box.userId, { email: box.user.email, score: result.score, name: box.name });
  }
  for (const hit of mailed.values()) {
    await notify(
      hit.email,
      `Buy box match · ${listing.title}`,
      `${listing.title} is live and scores ${hit.score} against “${hit.name}”. ${hit.score >= 80 ? "It sits close to the box." : "Open the book to underwrite it."}`,
    );
  }
}

export async function rescoreBox(boxId: string) {
  const box = await prisma.buyBox.findUnique({ where: { id: boxId }, include: { user: true } });
  if (!box) return 0;
  const listings = await prisma.listing.findMany({
    where: { status: { in: ["SUBMITTED", "UNDER_REVIEW", "CHANGES_REQUESTED", "APPROVED", "PENDING"] } },
    include: { notes: true },
  });
  let live = 0;
  for (const listing of listings) {
    const result = await writeMatch(listing.id, box, notesOf(listing.notes));
    if (result && listing.status === "APPROVED") live += 1;
  }
  if (live > 0 && box.active && box.user.role === "BUYER") {
    await notify(box.user.email, `Buy box · ${box.name}`, `${live} live listing${live === 1 ? "" : "s"} currently fit this box.`);
  }
  return live;
}
