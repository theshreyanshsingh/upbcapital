import type { BuyerEntity, InvestorEntity } from "@prisma/client";
import { audit } from "@/lib/audit";
import { notify, notifyDesk } from "@/lib/email";
import { entityLabel, IRA_NOTE, IRA_TITLE_EXAMPLE } from "@/lib/labels";
import { prisma } from "@/lib/prisma";
import { OFAC_DOWN_MESSAGE, OFAC_HOLD_MESSAGE, ofacHold, screenAndRecord } from "@/lib/screening";
import { entityVestingName } from "@/lib/vesting";

// One buyer login, several buying entities: the main buyer file the desk approved, plus other LLCs, trusts or a
// self-directed IRA the desk vets one by one. A bid names the entity it is for, and the closing papers name that
// entity, fixed at award (lib/vesting.ts). The funds credential and the strikes stay with the login.

export const ENTITY_TYPES = ["LLC", "TRUST", "FUND", "IRA", "INDIVIDUAL", "OTHER"] as const;
export const MAX_ENTITIES = 12;
export { IRA_NOTE, IRA_TITLE_EXAMPLE };

type EntityInput = { name: unknown; entityType: unknown; jurisdiction?: unknown; iraCustodian?: unknown; iraAccountTitle?: unknown };

const text = (value: unknown, max: number) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);

// The fields as the form sent them, checked. An IRA needs its custodian and the account title the paper vests in.
export function readEntity(input: EntityInput) {
  const entityType = text(input.entityType, 20);
  if (!(ENTITY_TYPES as readonly string[]).includes(entityType)) return { error: "Choose the kind of entity." } as const;
  const name = text(input.name, 160);
  if (name.length < 2) return { error: "Name the buying entity as it signs." } as const;
  const jurisdiction = text(input.jurisdiction, 80);
  const ira = entityType === "IRA";
  if (!ira && jurisdiction.length < 2) return { error: "Say where the entity is formed." } as const;
  const iraCustodian = ira ? text(input.iraCustodian, 160) : "";
  const iraAccountTitle = ira ? text(input.iraAccountTitle, 200) : "";
  if (ira && iraCustodian.length < 3) return { error: "Name the IRA's custodian." } as const;
  // The title names the custodian for the owner's benefit, which is how the paper has to vest.
  if (ira && (iraAccountTitle.length < 10 || !/\bFBO\b|benefit/i.test(iraAccountTitle))) {
    return { error: `Write the account title the way your custodian vests it, such as “${IRA_TITLE_EXAMPLE}”.` } as const;
  }
  return {
    error: null,
    data: {
      name,
      entityType: entityType as InvestorEntity,
      jurisdiction,
      iraCustodian: ira ? iraCustodian : null,
      iraAccountTitle: ira ? iraAccountTitle : null,
    },
  } as const;
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

// A buyer whose main file the desk approved adds another entity. It waits for the desk like the main file did.
export async function addBuyerEntity(user: { id: string; name: string }, input: EntityInput) {
  const profile = await prisma.buyerProfile.findUnique({ where: { userId: user.id }, select: { status: true, entityName: true } });
  if (profile?.status !== "APPROVED") return { error: "The desk approves your main buyer file first. Then you can add more buying entities." } as const;
  const read = readEntity(input);
  if (read.error !== null) return { error: read.error } as const;
  const own = await prisma.buyerEntity.findMany({ where: { userId: user.id }, select: { name: true, status: true } });
  const kept = own.filter((entity) => entity.status !== "REJECTED");
  if (sameName(read.data.name, profile.entityName) || kept.some((entity) => sameName(entity.name, read.data.name))) {
    return { error: "That entity is already on your file." } as const;
  }
  if (kept.length >= MAX_ENTITIES) return { error: `Your file holds ${MAX_ENTITIES} buying entities. Write the desk to add more.` } as const;
  const entity = await prisma.buyerEntity.create({ data: { userId: user.id, ...read.data, status: "SUBMITTED" } });
  await audit(user.id, "BUYER_ENTITY_ADDED", "user", user.id, `${entity.id} · ${entity.name} · ${entityLabel(entity.entityType)}`);
  const detail = entity.entityType === "IRA" ? `Custodian ${entity.iraCustodian}. Account title ${entity.iraAccountTitle}.` : `Formed in ${entity.jurisdiction}.`;
  await notifyDesk(`Buying entity submitted · ${user.name}`, `${entity.name} (${entityLabel(entity.entityType)}) is waiting on the desk. ${detail} Review it on the buyer files page.`);
  return { error: null, entity } as const;
}

// The entity's name, and an IRA's custodian too since the money comes from them, screened and recorded against the
// buyer's account. Every review and hold on the account (ofacHold) then covers the entity.
export async function screenEntity(entity: Pick<BuyerEntity, "userId" | "name" | "iraCustodian">, context: string) {
  const names = [...new Set([entity.name, entity.iraCustodian ?? ""].map((name) => name.trim()).filter(Boolean))];
  let unavailable = false;
  let blocked = false;
  for (const name of names) {
    const screen = await screenAndRecord(name, { context: `${context}: ${entity.name}`, userId: entity.userId });
    unavailable = unavailable || screen.unavailable;
    blocked = blocked || screen.blocked;
  }
  return { unavailable, blocked };
}

const LIVE_BIDS = ["OPEN", "REVIEWED"] as const;

// The desk approves or rejects one entity, with a note. Approval screens again and waits for the answer, as the main
// file's approval does, and an open or confirmed match on the account stops it.
export async function reviewBuyerEntity(reviewer: { id: string }, input: { entityId: string; decision: string; note: unknown }, now = new Date()) {
  const entity = await prisma.buyerEntity.findUnique({ where: { id: input.entityId }, include: { user: { select: { email: true, name: true } } } });
  if (!entity) return { error: "That buying entity no longer exists." } as const;
  const status = input.decision === "APPROVED" ? "APPROVED" : input.decision === "REJECTED" ? "REJECTED" : null;
  if (!status) return { error: "Approve or reject the entity." } as const;
  const note = text(input.note, 600);
  if (status === "REJECTED" && note.length < 3) return { error: "Tell the buyer why the entity is declined." } as const;
  if (status === "APPROVED") {
    if ((await screenEntity(entity, "Buying entity approval")).unavailable) return { error: OFAC_DOWN_MESSAGE } as const;
    if (await ofacHold({ userIds: [entity.userId] })) return { error: OFAC_HOLD_MESSAGE } as const;
  }
  // Claimed on the status as read, so two desk members deciding at once decide once.
  const claimed = await prisma.buyerEntity.updateMany({
    where: { id: entity.id, status: entity.status },
    data: { status, reviewerNote: note, reviewedById: reviewer.id, reviewedAt: now },
  });
  if (claimed.count !== 1) return { error: "The entity changed a moment ago. Check it and try again." } as const;
  await audit(reviewer.id, "BUYER_ENTITY_REVIEW", "user", entity.userId, `${entity.id} · ${entity.name} · ${status}${note ? ` · ${note}` : ""}`);
  // Bids already placed for an entity the desk now declines can't be awarded under it.
  const stranded = status === "REJECTED" ? await prisma.inquiry.count({ where: { buyerEntityId: entity.id, type: "OFFER", status: { in: [...LIVE_BIDS] } } }) : 0;
  await notify(
    entity.user.email,
    `Buying entity ${status === "APPROVED" ? "approved" : "declined"} · ${entity.name}`,
    status === "APPROVED"
      ? `The desk approved ${entity.name}. You can choose it when you bid.${note ? ` ${note}` : ""}`
      : `The desk declined ${entity.name}. ${note}${stranded ? ` ${stranded} open bid${stranded === 1 ? " is" : "s are"} for it, so ${stranded === 1 ? "it" : "they"} can't be awarded. Withdraw and bid again under another entity.` : ""}`,
  );
  return { error: null, status } as const;
}

export type EntityChoice = { id: string; name: string; kind: string; vestsAs: string; custodian: string | null };

// What a bid can be for: the main file first, as the empty choice, then every entity the desk approved. Empty when
// the main file isn't approved, since no bid goes through then.
export async function bidEntities(userId: string): Promise<EntityChoice[]> {
  const [profile, entities] = await Promise.all([
    prisma.buyerProfile.findUnique({ where: { userId }, select: { status: true, entityName: true, entityType: true } }),
    prisma.buyerEntity.findMany({ where: { userId, status: "APPROVED" }, orderBy: { createdAt: "asc" } }),
  ]);
  if (profile?.status !== "APPROVED") return [];
  const main = profile.entityName.trim() || "Your main buyer file";
  return [
    { id: "", name: main, kind: entityLabel(profile.entityType), vestsAs: main, custodian: null },
    ...entities.map((entity) => ({ id: entity.id, name: entity.name, kind: entityLabel(entity.entityType), vestsAs: entityVestingName(entity), custodian: entity.iraCustodian ?? null })),
  ];
}

// The entity a bid names, checked: the buyer's own and approved. A blank choice is the main file.
export async function chosenEntity(userId: string, raw: unknown) {
  const id = String(raw ?? "").trim();
  if (!id) return { error: null, entityId: null } as const;
  const entity = await prisma.buyerEntity.findUnique({ where: { id }, select: { id: true, userId: true, status: true } });
  if (!entity || entity.userId !== userId) return { error: "Choose one of your own buying entities." } as const;
  if (entity.status !== "APPROVED") return { error: "That buying entity isn't approved by the desk yet. Choose an approved one, or your main file." } as const;
  return { error: null, entityId: entity.id } as const;
}

// Why a bid can't be awarded under the entity it names, or null. The desk can decline an entity after a bid is in.
export async function entityAwardBlock(bid: { buyerId: string; buyerEntityId?: string | null }) {
  if (!bid.buyerEntityId) return null;
  const entity = await prisma.buyerEntity.findUnique({ where: { id: bid.buyerEntityId }, select: { userId: true, status: true, name: true } });
  if (!entity || entity.userId !== bid.buyerId) return "This bid's buying entity is no longer on the buyer's file.";
  if (entity.status !== "APPROVED") return `This bid is for ${entity.name}, which the desk hasn't approved. Approve it on the buyer files page first.`;
  return null;
}

// The entity names bids are for, for the offer book and the bid sheet. Bids on the main file have none.
export async function bidEntityNames(entityIds: (string | null | undefined)[]) {
  const ids = [...new Set(entityIds.filter((id): id is string => Boolean(id)))];
  if (!ids.length) return new Map<string, { name: string; kind: string }>();
  const rows = await prisma.buyerEntity.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, entityType: true } });
  return new Map(rows.map((row) => [row.id, { name: row.name, kind: entityLabel(row.entityType) }]));
}
