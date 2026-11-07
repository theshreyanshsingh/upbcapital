import type { BeneficialOwner } from "@prisma/client";
import { audit } from "@/lib/audit";
import { unset } from "@/lib/db-filters";
import { notifyDesk } from "@/lib/email";
import { entityLabel } from "@/lib/labels";
import { ofacOpen } from "@/lib/ofac";
import { prisma } from "@/lib/prisma";
import { OFAC_DOWN_MESSAGE, screenAndRecord } from "@/lib/screening";

// Who owns and who runs a buyer that isn't a person. FinCEN's customer due diligence rule asks for every person who
// owns 25% or more of a legal-entity customer and one person who controls it, and FIXnotes asks its buyers the same.
// Owners belong to the buyer's main file, or to one of their buying entities. Each is screened when saved, and the
// desk approves no file while an owner's screen is open or confirmed.

export const OWNER_THRESHOLD = 25;
export const MAX_OWNERS = 20;
export const OWNER_CONTEXT = "beneficial-owner";

export const OWNERS_INTRO = `List every person who owns ${OWNER_THRESHOLD}% or more of the entity, directly or through other entities, and at least one person who controls it, such as a managing member, an officer or a trustee. One person can be both.`;

// A person signs for themselves, and an IRA's owner is the person on the account, so neither lists owners.
const NO_OWNERS = new Set(["INDIVIDUAL", "IRA"]);

export function needsOwners(entityType: string | null | undefined) {
  return !NO_OWNERS.has(String(entityType ?? "INDIVIDUAL"));
}

type OwnerFacts = { ownershipPct: number | null; controlPerson: boolean };

export function ownershipTotal(owners: Pick<OwnerFacts, "ownershipPct">[]) {
  return owners.reduce((sum, owner) => sum + (owner.ownershipPct ?? 0), 0);
}

const percent = (value: number) => `${Number(value.toFixed(2))}%`;

// What still stops the file going to the desk. Empty when nothing does.
export function ownerGaps(entityType: string | null | undefined, owners: OwnerFacts[]) {
  if (!needsOwners(entityType)) return [];
  const gaps: string[] = [];
  if (!owners.some((owner) => owner.controlPerson)) gaps.push("Name at least one control person, such as a managing member, an officer or a trustee.");
  const total = ownershipTotal(owners);
  // A hundredth of slack for shares typed as thirds.
  if (total > 100.01) gaps.push(`The ownership shares add up to ${percent(total)}. They can't total more than 100%.`);
  return gaps;
}

type OwnerInput = { name: unknown; title?: unknown; ownershipPct?: unknown; controlPerson?: unknown; country?: unknown };

const text = (value: unknown, max: number) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);

// One owner as the form sent it, checked. Someone under the threshold is listed only when they control the entity.
export function readOwner(input: OwnerInput) {
  const name = text(input.name, 120);
  if (name.length < 2) return { error: "Write the owner's full legal name." } as const;
  const raw = text(input.ownershipPct, 12).replace(/%$/, "").trim();
  const ownershipPct = raw ? Number(raw) : null;
  if (ownershipPct != null && (!Number.isFinite(ownershipPct) || ownershipPct < 0 || ownershipPct > 100)) {
    return { error: "Write the share owned as a percentage from 0 to 100, or leave it blank." } as const;
  }
  const controlPerson = input.controlPerson === true || input.controlPerson === "yes" || input.controlPerson === "on";
  if (!controlPerson && (ownershipPct ?? 0) < OWNER_THRESHOLD) {
    return { error: `List owners of ${OWNER_THRESHOLD}% or more, and the people who control the entity. Smaller owners who don't control it aren't needed.` } as const;
  }
  return {
    error: null,
    data: {
      name,
      title: text(input.title, 80),
      ownershipPct: ownershipPct == null ? null : Math.round(ownershipPct * 100) / 100,
      controlPerson,
      country: text(input.country, 56) || "US",
    },
  } as const;
}

// The main file's owners have no entity. Older rows may lack the field rather than hold null.
export function fileScope(buyerEntityId: string | null | undefined) {
  return buyerEntityId ? { buyerEntityId } : unset("buyerEntityId");
}

export function fileKey(userId: string, buyerEntityId: string | null | undefined) {
  return `${userId}:${buyerEntityId || "main"}`;
}

export function ownersOf(userId: string, buyerEntityId: string | null | undefined) {
  return prisma.beneficialOwner.findMany({ where: { userId, ...fileScope(buyerEntityId) }, orderBy: { createdAt: "asc" } });
}

export async function fileGaps(userId: string, buyerEntityId: string | null, entityType: string) {
  return ownerGaps(entityType, await ownersOf(userId, buyerEntityId));
}

// The file an owner change is for: the main file, or one of the buyer's own entities. A declined entity is closed;
// the buyer adds it again with its fixes.
async function ownedFile(userId: string, buyerEntityId: string | null) {
  if (!buyerEntityId) {
    const profile = await prisma.buyerProfile.findUnique({ where: { userId }, select: { status: true, entityType: true, entityName: true } });
    return { error: null, file: { status: profile?.status ?? "NOT_STARTED", entityType: profile?.entityType ?? "INDIVIDUAL", name: profile?.entityName || "your main file" } } as const;
  }
  const entity = await prisma.buyerEntity.findUnique({ where: { id: buyerEntityId }, select: { userId: true, status: true, entityType: true, name: true } });
  if (!entity || entity.userId !== userId) return { error: "Choose one of your own buying entities." } as const;
  if (entity.status === "REJECTED") return { error: "The desk declined this entity. Add it again to change its owners." } as const;
  if (!needsOwners(entity.entityType)) return { error: `${entityLabel(entity.entityType)} entities have no owners to list.` } as const;
  return { error: null, file: { status: entity.status, entityType: entity.entityType, name: entity.name } } as const;
}

// CLEAR, REVIEW or MATCH, from the screen row. A REVIEW the desk confirmed is a MATCH. A clear answer from a list that
// couldn't be read isn't one, so it stays unscreened and the approval screens again.
export function screenResultOf(check: { result: string; status?: string | null }, unavailable = false) {
  if (check.result === "REVIEW") return check.status === "CONFIRMED" ? "MATCH" : "REVIEW";
  return unavailable ? null : "CLEAR";
}

// Screens one owner against the account, so every review and hold on the account (ofacHold) covers them too.
export async function screenOwner(owner: Pick<BeneficialOwner, "id" | "userId" | "name">, now = new Date()) {
  const { check, unavailable } = await screenAndRecord(owner.name, { context: OWNER_CONTEXT, userId: owner.userId });
  const screenResult = screenResultOf(check, unavailable);
  if (screenResult) await prisma.beneficialOwner.update({ where: { id: owner.id }, data: { screenResult, screenedAt: now } });
  return { screenResult, unavailable, check };
}

const changedOn = (file: { status: string }) => file.status === "APPROVED" || file.status === "SUBMITTED";

// The buyer lists an owner. The screen runs before the reply so the desk sees its answer beside the name. An owner
// added to an approved file goes to the desk, which can ask for changes.
export async function addBeneficialOwner(user: { id: string; name: string }, input: OwnerInput & { buyerEntityId?: unknown }, now = new Date()) {
  const buyerEntityId = text(input.buyerEntityId, 64) || null;
  const found = await ownedFile(user.id, buyerEntityId);
  if (found.error !== null) return { error: found.error } as const;
  const read = readOwner(input);
  if (read.error !== null) return { error: read.error } as const;
  const existing = await ownersOf(user.id, buyerEntityId);
  if (existing.length >= MAX_OWNERS) return { error: `A file lists up to ${MAX_OWNERS} owners. Write the desk to add more.` } as const;
  if (existing.some((owner) => owner.name.toLowerCase() === read.data.name.toLowerCase())) return { error: "That person is already listed." } as const;
  const total = ownershipTotal([...existing, read.data]);
  if (total > 100.01) return { error: `That brings the ownership shares to ${percent(total)}. They can't total more than 100%.` } as const;
  const owner = await prisma.beneficialOwner.create({ data: { userId: user.id, buyerEntityId, ...read.data } });
  const screen = await screenOwner(owner, now);
  await audit(user.id, "BENEFICIAL_OWNER_ADDED", "user", user.id, `${owner.id} · ${owner.name} · ${buyerEntityId ? `entity ${buyerEntityId}` : "main file"}`);
  if (found.file.status === "APPROVED") {
    await notifyDesk(`Owner added · ${user.name}`, `${user.name} added ${owner.name} as an owner of ${found.file.name}, which the desk approved. Review it on the buyer files page.`);
  }
  return { error: null, owner: { ...owner, screenResult: screen.screenResult } } as const;
}

// The buyer removes an owner. A file with the desk, or approved, keeps a control person: the buyer adds the new one
// first.
export async function removeBeneficialOwner(user: { id: string; name: string }, ownerId: string) {
  const owner = await prisma.beneficialOwner.findUnique({ where: { id: ownerId } });
  if (!owner || owner.userId !== user.id) return { error: "That owner isn't on your file." } as const;
  const found = await ownedFile(user.id, owner.buyerEntityId ?? null);
  if (found.error !== null) return { error: found.error } as const;
  if (changedOn(found.file)) {
    const left = (await ownersOf(user.id, owner.buyerEntityId)).filter((row) => row.id !== owner.id);
    if (ownerGaps(found.file.entityType, left).length) return { error: "Add another control person before you remove this one." } as const;
  }
  await prisma.beneficialOwner.delete({ where: { id: owner.id } });
  await audit(user.id, "BENEFICIAL_OWNER_REMOVED", "user", user.id, `${owner.id} · ${owner.name}`);
  if (found.file.status === "APPROVED") {
    await notifyDesk(`Owner removed · ${user.name}`, `${user.name} removed ${owner.name} as an owner of ${found.file.name}, which the desk approved. Review it on the buyer files page.`);
  }
  return { error: null } as const;
}

// Why the desk can't approve this file for its owners, or null. Like every approval, it screens each owner again and
// waits for the answer. A confirmed match, or a review nobody has decided, stops it.
export async function ownerApprovalBlock(file: { userId: string; buyerEntityId: string | null; entityType: string }, now = new Date()) {
  const owners = await ownersOf(file.userId, file.buyerEntityId);
  const gaps = ownerGaps(file.entityType, owners);
  if (gaps.length) return `${gaps.join(" ")} Ask the buyer to fix the owners before approving.`;
  let unavailable = false;
  for (const owner of owners) {
    const screen = await screenOwner(owner, now);
    unavailable = unavailable || screen.unavailable;
    if (screen.screenResult === "MATCH") return `${owner.name}, an owner on this file, is a confirmed sanctions match. The file can't be approved.`;
    if (screen.screenResult === "REVIEW" && ofacOpen(screen.check)) {
      return `${owner.name}, an owner on this file, has an open sanctions review. Decide it under Compliance before approving.`;
    }
  }
  return unavailable ? OFAC_DOWN_MESSAGE : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Owners as the desk reads them, with each screen as it stands now. A review the desk decided since the save shows
// its decision.

export type OwnerScreen = "CLEAR" | "OPEN" | "CLEARED" | "MATCH" | "NOT_SCREENED";

export type OwnerView = {
  id: string;
  buyerEntityId: string | null;
  name: string;
  title: string;
  ownershipPct: number | null;
  controlPerson: boolean;
  country: string;
  screen: OwnerScreen;
  screenedAt: Date | null;
};

export const SCREEN_LABELS: Record<OwnerScreen, string> = {
  CLEAR: "Clear",
  OPEN: "Open review",
  CLEARED: "Review cleared",
  MATCH: "Confirmed match",
  NOT_SCREENED: "Not screened yet",
};

export function ownerScreen(owner: Pick<BeneficialOwner, "name" | "screenResult">, reviews: { name: string; result: string; status?: string | null }[]): OwnerScreen {
  if (!owner.screenResult) return "NOT_SCREENED";
  if (owner.screenResult === "CLEAR") return "CLEAR";
  const rows = reviews.filter((row) => row.name === owner.name && row.result === "REVIEW");
  if (owner.screenResult === "MATCH" || rows.some((row) => row.status === "CONFIRMED")) return "MATCH";
  return rows.some(ofacOpen) || !rows.length ? "OPEN" : "CLEARED";
}

// Every owner on these buyers' files, by fileKey.
export async function ownersByFile(userIds: string[]) {
  const byFile = new Map<string, OwnerView[]>();
  if (!userIds.length) return byFile;
  const owners = await prisma.beneficialOwner.findMany({ where: { userId: { in: userIds } }, orderBy: { createdAt: "asc" } });
  const flagged = owners.filter((owner) => owner.screenResult && owner.screenResult !== "CLEAR");
  const reviews = flagged.length
    ? await prisma.ofacCheck.findMany({
        where: { result: "REVIEW", userId: { in: [...new Set(flagged.map((owner) => owner.userId))] }, name: { in: [...new Set(flagged.map((owner) => owner.name))] } },
        select: { userId: true, name: true, result: true, status: true },
      })
    : [];
  for (const owner of owners) {
    const key = fileKey(owner.userId, owner.buyerEntityId);
    const view: OwnerView = {
      id: owner.id,
      buyerEntityId: owner.buyerEntityId ?? null,
      name: owner.name,
      title: owner.title,
      ownershipPct: owner.ownershipPct ?? null,
      controlPerson: owner.controlPerson,
      country: owner.country,
      screen: ownerScreen(owner, reviews.filter((row) => row.userId === owner.userId)),
      screenedAt: owner.screenedAt ?? null,
    };
    byFile.set(key, [...(byFile.get(key) ?? []), view]);
  }
  return byFile;
}

// "Managing member · 60% · control person · US", for the lists on both sides.
export function ownerLine(owner: Pick<OwnerView, "title" | "ownershipPct" | "controlPerson" | "country">) {
  return [owner.title, owner.ownershipPct != null ? percent(owner.ownershipPct) : "", owner.controlPerson ? "control person" : "", owner.country].filter(Boolean).join(" · ");
}
