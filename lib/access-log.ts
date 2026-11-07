import { canManageRoom } from "@/lib/acl";
import { bidderAliases } from "@/lib/bidder-alias";
import { toCsv } from "@/lib/csv";
import { destructionLabel } from "@/lib/destruction";
import { prisma } from "@/lib/prisma";

// Who took which file from a listing's room and when, with each bidder's NDA and access decision. The seller and
// broker read bidders by letter until an award; the desk reads the vetted entity, with the letter beside it so both
// sides can talk about the same bidder.

type Viewer = { id: string; role: string };

export const ACCESS_LOG_COLUMNS = ["bidder", "event", "file", "at", "nda_signed_at", "access", "access_decided_at", "files_destroyed", "destroyed_at"] as const;
type LogRow = Record<(typeof ACCESS_LOG_COLUMNS)[number], string>;

// destruction is "Asked" once a losing bidder was asked to certify they destroyed the files, "Certified" once they did.
export type Engagement = { userId: string; bidder: string; ndaSignedAt: Date | null; access: string; files: number; downloads: number; lastActivity: Date | null; destruction: string; destroyedAt: Date | null };

function accessLabel(nda: { accessStatus?: string | null } | undefined) {
  if (!nda) return "No NDA";
  if (nda.accessStatus === "PENDING") return "Waiting";
  if (nda.accessStatus === "DECLINED") return "Declined";
  return "Open";
}

const iso = (at: Date | null | undefined) => (at ? at.toISOString() : "");

export async function accessLog(listingId: string, viewer: Viewer) {
  const listing = await prisma.listing.findUnique({ where: { id: listingId }, select: { id: true, title: true, sellerId: true, brokerId: true } });
  if (!listing) return { status: 404 as const };
  if (!canManageRoom(viewer, listing)) return { status: 403 as const };
  const desk = viewer.role === "ADMIN";
  const [downloads, ndas, views, awarded, aliases] = await Promise.all([
    prisma.auditEvent.findMany({
      where: { entityType: "listing", entityId: listing.id, action: "DOCUMENT_DOWNLOAD" },
      include: { actor: { select: { id: true, name: true, companyName: true, role: true } } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.ndaAcknowledgment.findMany({ where: { listingId: listing.id }, include: { user: { select: { id: true, name: true, companyName: true, role: true } } }, orderBy: { acknowledgedAt: "asc" } }),
    prisma.listingView.findMany({ where: { listingId: listing.id }, select: { userId: true, createdAt: true } }),
    prisma.inquiry.findMany({ where: { listingId: listing.id, status: "ACCEPTED" }, select: { buyerId: true } }),
    bidderAliases(listing.id),
  ]);
  // The seller, the broker and the desk taking their own files aren't bidders.
  const bidderActor = (actor: { id: string; role: string } | null): actor is { id: string; name: string; companyName: string; role: string } =>
    Boolean(actor && actor.id !== listing.sellerId && actor.id !== listing.brokerId && actor.role !== "ADMIN");
  const people = new Map<string, { name: string; companyName: string }>();
  for (const row of downloads) if (bidderActor(row.actor)) people.set(row.actor.id, row.actor);
  for (const nda of ndas) if (bidderActor(nda.user)) people.set(nda.userId, nda.user);
  const profiles = desk && people.size
    ? await prisma.buyerProfile.findMany({ where: { userId: { in: [...people.keys()] } }, select: { userId: true, entityName: true } })
    : [];
  const entity = new Map(profiles.map((profile) => [profile.userId, profile.entityName]));
  const named = new Set(awarded.map((row) => row.buyerId));
  const label = (userId: string) => {
    const alias = aliases.get(userId) ?? "A bidder";
    const person = people.get(userId);
    const real = entity.get(userId) || person?.companyName || person?.name || "Unknown buyer";
    if (desk) return aliases.has(userId) ? `${real} (${alias})` : real;
    return named.has(userId) ? real : alias;
  };
  const ndaBy = new Map(ndas.map((nda) => [nda.userId, nda]));

  const entries: { at: number; row: LogRow }[] = [];
  const context = (userId: string) => {
    const nda = ndaBy.get(userId);
    return { nda_signed_at: iso(nda?.acknowledgedAt), access: accessLabel(nda), access_decided_at: iso(nda?.accessDecidedAt), files_destroyed: destructionLabel(nda), destroyed_at: iso(nda?.destroyedAt) };
  };
  for (const nda of ndas) {
    if (!bidderActor(nda.user)) continue;
    entries.push({ at: nda.acknowledgedAt.getTime(), row: { bidder: label(nda.userId), event: "NDA signed", file: "", at: iso(nda.acknowledgedAt), ...context(nda.userId) } });
    if (nda.accessDecidedAt && (nda.accessStatus === "APPROVED" || nda.accessStatus === "DECLINED")) {
      const event = nda.accessStatus === "APPROVED" ? "Access approved" : "Access declined";
      entries.push({ at: nda.accessDecidedAt.getTime(), row: { bidder: label(nda.userId), event, file: "", at: iso(nda.accessDecidedAt), ...context(nda.userId) } });
    }
    if (nda.destroyRequestedAt) {
      entries.push({ at: nda.destroyRequestedAt.getTime(), row: { bidder: label(nda.userId), event: "Asked to destroy files", file: "", at: iso(nda.destroyRequestedAt), ...context(nda.userId) } });
    }
    if (nda.destroyedAt) {
      entries.push({ at: nda.destroyedAt.getTime(), row: { bidder: label(nda.userId), event: "Certified files destroyed", file: "", at: iso(nda.destroyedAt), ...context(nda.userId) } });
    }
  }
  for (const row of downloads) {
    if (!bidderActor(row.actor)) continue;
    entries.push({ at: row.createdAt.getTime(), row: { bidder: label(row.actor.id), event: "Download", file: row.detail, at: iso(row.createdAt), ...context(row.actor.id) } });
  }
  const rows = entries.sort((a, b) => a.at - b.at).map((entry) => entry.row);

  // One line per bidder: what they took and when they were last in the listing.
  const engagement = new Map<string, Engagement>();
  const touch = (userId: string, at: Date) => {
    const row = engagement.get(userId);
    if (row && (!row.lastActivity || at > row.lastActivity)) row.lastActivity = at;
  };
  for (const userId of people.keys()) {
    const nda = ndaBy.get(userId);
    engagement.set(userId, { userId, bidder: label(userId), ndaSignedAt: nda?.acknowledgedAt ?? null, access: accessLabel(nda), files: 0, downloads: 0, lastActivity: nda?.acknowledgedAt ?? null, destruction: destructionLabel(nda), destroyedAt: nda?.destroyedAt ?? null });
  }
  const taken = new Map<string, Set<string>>();
  for (const row of downloads) {
    if (!bidderActor(row.actor)) continue;
    const line = engagement.get(row.actor.id)!;
    line.downloads += 1;
    const files = taken.get(row.actor.id) ?? new Set<string>();
    files.add(row.detail);
    taken.set(row.actor.id, files);
    line.files = files.size;
    touch(row.actor.id, row.createdAt);
  }
  for (const view of views) if (view.userId) touch(view.userId, view.createdAt);
  const summary = [...engagement.values()].sort((a, b) => (b.lastActivity?.getTime() ?? 0) - (a.lastActivity?.getTime() ?? 0));
  return { status: 200 as const, listing, rows, engagement: summary };
}

export function accessLogCsv(rows: LogRow[]) {
  // A room nobody has entered still gets its header line.
  return rows.length ? toCsv(rows) : ACCESS_LOG_COLUMNS.join(",");
}
