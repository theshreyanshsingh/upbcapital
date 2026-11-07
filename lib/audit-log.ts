import type { Prisma } from "@prisma/client";
import { toCsv } from "@/lib/csv";
import { literal } from "@/lib/db-filters";
import { prisma } from "@/lib/prisma";

// The audit log as the desk and an examiner read it: filtered by who, what, which record and when, a page at a
// time, and the same filter as a CSV. Dates are UTC days, as everywhere on the desk.

export const AUDIT_PAGE_SIZE = 100;
// A CSV holds this many events at most. A wider filter says so in its last row rather than cutting silently.
export const AUDIT_CSV_LIMIT = 50000;

export type AuditFilter = {
  actor: string;
  action: string;
  entityType: string;
  entityId: string;
  from: string;
  to: string;
};

type Params = Record<string, string | string[] | undefined> | URLSearchParams;

function read(params: Params, key: string) {
  const value = params instanceof URLSearchParams ? params.get(key) : params[key];
  return String(Array.isArray(value) ? value[0] ?? "" : value ?? "").trim().slice(0, 120);
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function auditFilterFrom(params: Params): AuditFilter {
  const day = (key: string) => (DAY_RE.test(read(params, key)) ? read(params, key) : "");
  return {
    actor: read(params, "actor"),
    action: read(params, "action").toUpperCase().replace(/[^A-Z0-9_]/g, ""),
    entityType: read(params, "entityType").replace(/[^A-Za-z]/g, ""),
    entityId: read(params, "entityId").replace(/[^A-Za-z0-9_-]/g, ""),
    from: day("from"),
    to: day("to"),
  };
}

export function auditQuery(filter: AuditFilter, page?: number) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) if (value) query.set(key, value);
  if (page && page > 1) query.set("page", String(page));
  return query.toString();
}

// The actor box takes a name, an email or an account id. "system" finds what the app did on its own.
async function actorIds(actor: string) {
  if (!actor) return null;
  if (actor.toLowerCase() === "system") return [] as string[];
  const text = { contains: literal(actor), mode: "insensitive" as const };
  const people = await prisma.user.findMany({
    where: { OR: [{ name: text }, { email: text }, ...(/^[a-z0-9]{20,}$/i.test(actor) ? [{ id: actor }] : [])] },
    select: { id: true },
    take: 200,
  });
  return people.map((person) => person.id);
}

export async function auditWhere(filter: AuditFilter): Promise<Prisma.AuditEventWhereInput> {
  const where: Prisma.AuditEventWhereInput[] = [];
  const ids = await actorIds(filter.actor);
  if (ids) where.push(filter.actor.toLowerCase() === "system" ? { OR: [{ actorId: null }, { actorId: { isSet: false } }] } : { actorId: { in: ids } });
  if (filter.action) where.push({ action: filter.action });
  if (filter.entityType) where.push({ entityType: filter.entityType });
  if (filter.entityId) where.push({ entityId: filter.entityId });
  const createdAt: Prisma.DateTimeFilter = {};
  if (filter.from) createdAt.gte = new Date(`${filter.from}T00:00:00Z`);
  if (filter.to) createdAt.lte = new Date(`${filter.to}T23:59:59.999Z`);
  if (filter.from || filter.to) where.push({ createdAt });
  return where.length ? { AND: where } : {};
}

export async function auditPage(filter: AuditFilter, page = 1, size = AUDIT_PAGE_SIZE) {
  const where = await auditWhere(filter);
  const total = await prisma.auditEvent.count({ where });
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(1, Math.floor(page) || 1), pages);
  const events = await prisma.auditEvent.findMany({
    where,
    include: { actor: { select: { name: true, email: true } } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    skip: (current - 1) * size,
    take: size,
  });
  return { events, total, page: current, pages };
}

// The actions and record types on file, for the filter's pickers.
export async function auditVocabulary() {
  const [actions, types] = await Promise.all([
    prisma.auditEvent.findMany({ distinct: ["action"], select: { action: true }, orderBy: { action: "asc" } }),
    prisma.auditEvent.findMany({ distinct: ["entityType"], select: { entityType: true }, orderBy: { entityType: "asc" } }),
  ]);
  return { actions: actions.map((row) => row.action), entityTypes: types.map((row) => row.entityType) };
}

type CsvEvent = {
  id: string;
  createdAt: Date;
  actorId: string | null;
  actor: { name: string; email: string } | null;
  action: string;
  entityType: string;
  entityId: string;
  detail: string;
};

export function auditCsv(events: CsvEvent[], cut = false) {
  const rows = events.map((event) => ({
    time_utc: event.createdAt.toISOString(),
    actor: event.actor?.name ?? (event.actorId ? "Removed account" : "System"),
    actor_email: event.actor?.email ?? "",
    actor_id: event.actorId ?? "",
    action: event.action,
    entity_type: event.entityType,
    entity_id: event.entityId,
    detail: event.detail,
    event_id: event.id,
  }));
  if (cut) {
    rows.push({ time_utc: "", actor: "", actor_email: "", actor_id: "", action: "", entity_type: "", entity_id: "", detail: `Stopped at ${AUDIT_CSV_LIMIT.toLocaleString("en-US")} events. Narrow the dates for the rest.`, event_id: "" });
  }
  return rows.length ? toCsv(rows) : "time_utc,actor,actor_email,actor_id,action,entity_type,entity_id,detail,event_id";
}

export async function auditExport(filter: AuditFilter) {
  const where = await auditWhere(filter);
  const events = await prisma.auditEvent.findMany({
    where,
    include: { actor: { select: { name: true, email: true } } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: AUDIT_CSV_LIMIT + 1,
  });
  const cut = events.length > AUDIT_CSV_LIMIT;
  return auditCsv(cut ? events.slice(0, AUDIT_CSV_LIMIT) : events, cut);
}
