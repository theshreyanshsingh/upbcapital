import { audit } from "@/lib/audit";
import { deskCan, DESK_DENIED, type Staff } from "@/lib/desk-roles";
import { US_STATES } from "@/lib/labels";
import { prisma } from "@/lib/prisma";
import { SERVICER_SOURCES } from "@/lib/servicer-import";

// The servicer directory. The closings side of the desk keeps it: who boards purchased loans, in which states, at
// what fees, and whether UPB reads their export (lib/servicer-import.ts). Everything shown comes from what the desk
// entered here. A buyer boarding a closed loan can pick a servicer from it, or name one that isn't on it.

type Actor = Staff & { id: string };
type Outcome<T> = { ok: true; value: T } | { ok: false; error: string };

const fail = (error: string) => ({ ok: false as const, error });

export const NAME_MAX = 120;
export const FEE_MAX = 80;
export const NOTE_MAX = 1000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// The exports the servicer import reads, by format key. "OTHER" reads any export by its column headers.
export const IMPORT_FORMATS = SERVICER_SOURCES.filter((source) => source.kind === "servicer").map((source) => ({
  value: source.value,
  label: source.value === "OTHER" ? "Another export, read by its column headers" : `${source.label} export`,
}));

export function importFormatLabel(format: string | null | undefined) {
  return IMPORT_FORMATS.find((row) => row.value === format)?.label ?? null;
}

export type ServicerFields = {
  name: string;
  website: string;
  contactEmail: string;
  states: string[];
  importFormat: string | null;
  boardingFee: string;
  monthlyFee: string;
  notes: string;
};

const squeeze = (value: unknown, max: number) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);

// "FL, GA tx" or "FL GA": two-letter states, upper case, each once, in the order typed.
export function readStates(raw: unknown) {
  const codes = String(raw ?? "").toUpperCase().split(/[\s,;/]+/).filter(Boolean);
  const unknown = codes.filter((code) => !(US_STATES as readonly string[]).includes(code));
  return { states: [...new Set(codes.filter((code) => !unknown.includes(code)))], unknown };
}

// A site as typed, with https:// added when it has no scheme. Only web addresses.
export function readWebsite(raw: unknown) {
  const text = String(raw ?? "").trim().slice(0, 200);
  if (!text) return "";
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (!url.hostname.includes(".")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function readServicerForm(raw: Record<string, unknown>): { error: string } | { error: null; fields: ServicerFields } {
  const name = squeeze(raw.name, NAME_MAX + 1);
  if (name.length < 2 || name.length > NAME_MAX) return { error: "Name the servicer." };
  const website = readWebsite(raw.website);
  if (website === null) return { error: "Enter the servicer's website, such as example.com, or leave it blank." };
  const contactEmail = String(raw.contactEmail ?? "").trim().slice(0, 200);
  if (contactEmail && !EMAIL.test(contactEmail)) return { error: "Enter a boarding email, or leave it blank." };
  const { states, unknown } = readStates(raw.states);
  if (unknown.length) return { error: `${unknown.slice(0, 3).join(", ")} ${unknown.length === 1 ? "isn't a" : "aren't"} two-letter state${unknown.length === 1 ? "" : "s"}.` };
  const format = String(raw.importFormat ?? "").trim();
  if (format && !importFormatLabel(format)) return { error: "Choose an export UPB reads, or none." };
  return {
    error: null,
    fields: {
      name,
      website,
      contactEmail,
      states,
      importFormat: format || null,
      boardingFee: squeeze(raw.boardingFee, FEE_MAX),
      monthlyFee: squeeze(raw.monthlyFee, FEE_MAX),
      notes: String(raw.notes ?? "").replace(/\r\n/g, "\n").trim().slice(0, NOTE_MAX),
    },
  };
}

const LABELS: Record<keyof ServicerFields, string> = {
  name: "name",
  website: "website",
  contactEmail: "email",
  states: "states",
  importFormat: "export",
  boardingFee: "boarding fee",
  monthlyFee: "monthly fee",
  notes: "notes",
};

// Adds a servicer, or edits one when an id is given. Only the closings side of the desk keeps the directory.
export async function saveServicer(actor: Actor, input: { id?: string | null } & Record<string, unknown>): Promise<Outcome<{ id: string; created: boolean }>> {
  if (!deskCan(actor, "closings")) return fail(DESK_DENIED);
  const read = readServicerForm(input);
  if (read.error !== null) return fail(read.error);
  const { fields } = read;
  const id = input.id ? String(input.id) : null;
  const before = id ? await prisma.servicer.findUnique({ where: { id } }) : null;
  if (id && !before) return fail("That servicer isn't on the directory.");
  // Names are unique however they are typed, so "fci" and "FCI" are one servicer. The directory is short enough
  // to compare here.
  const names = await prisma.servicer.findMany({ select: { id: true, name: true } });
  if (names.some((row) => row.id !== id && row.name.toLowerCase() === fields.name.toLowerCase())) return fail("A servicer with that name is already on the directory.");
  try {
    if (before) {
      const changed = (Object.keys(LABELS) as (keyof ServicerFields)[]).filter((key) => JSON.stringify(before[key] ?? null) !== JSON.stringify(fields[key] ?? null));
      if (!changed.length) return { ok: true, value: { id: before.id, created: false } };
      await prisma.servicer.update({ where: { id: before.id }, data: fields });
      await audit(actor.id, "SERVICER_EDIT", "servicer", before.id, `${fields.name}: ${changed.map((key) => LABELS[key]).join(", ")}`);
      return { ok: true, value: { id: before.id, created: false } };
    }
    const made = await prisma.servicer.create({ data: fields });
    await audit(actor.id, "SERVICER_ADD", "servicer", made.id, fields.name);
    return { ok: true, value: { id: made.id, created: true } };
  } catch (error) {
    // Two desk members adding the same name at once: the unique index answers for the second.
    if (error && typeof error === "object" && (error as { code?: string }).code === "P2002") return fail("A servicer with that name is already on the directory.");
    throw error;
  }
}

// Off the directory, or back on it. A boarding that already names a servicer keeps it.
export async function setServicerActive(actor: Actor, input: { id: string; active: boolean }): Promise<Outcome<{ id: string }>> {
  if (!deskCan(actor, "closings")) return fail(DESK_DENIED);
  const servicer = await prisma.servicer.findUnique({ where: { id: String(input.id || "") }, select: { id: true, name: true, active: true } });
  if (!servicer) return fail("That servicer isn't on the directory.");
  if (servicer.active === input.active) return { ok: true, value: { id: servicer.id } };
  const moved = await prisma.servicer.updateMany({ where: { id: servicer.id, active: servicer.active }, data: { active: input.active } });
  if (moved.count === 1) await audit(actor.id, input.active ? "SERVICER_REACTIVATE" : "SERVICER_DEACTIVATE", "servicer", servicer.id, servicer.name);
  return { ok: true, value: { id: servicer.id } };
}

// The public directory and the boarding pick-list: active servicers only, by name.
export async function activeServicers() {
  return prisma.servicer.findMany({ where: { active: true }, orderBy: { name: "asc" } });
}

// The desk's page: everything, active first.
export async function allServicers() {
  const rows = await prisma.servicer.findMany({ orderBy: { name: "asc" } });
  return [...rows.filter((row) => row.active), ...rows.filter((row) => !row.active)];
}

// ---------------------------------------------------------------------------------------------------------------
// Boarding a closed loan.

// The loan states a servicer doesn't list. A servicer that lists no states can't be checked, which is said apart.
export function stateGaps(servicerStates: string[], loanStates: string[]) {
  const listed = new Set(servicerStates.map((state) => state.toUpperCase()));
  const loans = [...new Set(loanStates.map((state) => state.toUpperCase()).filter(Boolean))];
  return { unlisted: listed.size === 0, missing: listed.size === 0 ? [] : loans.filter((state) => !listed.has(state)) };
}

export type BoardingChoice = { id: string; name: string; contactEmail: string; states: string[]; missing: string[]; unlisted: boolean; active: boolean };

// The boarding form's pick-list, each with the loan states it doesn't list. The servicer a boarding already names
// stays on it after the desk takes it off the directory, so saving the form again doesn't drop it.
export async function boardingChoices(loanStates: string[], currentId?: string | null): Promise<BoardingChoice[]> {
  const rows = await prisma.servicer.findMany({ where: { OR: [{ active: true }, ...(currentId ? [{ id: currentId }] : [])] }, orderBy: { name: "asc" } });
  return rows.map((row) => ({ id: row.id, name: row.name, contactEmail: row.contactEmail, states: row.states, active: row.active, ...stateGaps(row.states, loanStates) }));
}

// What a boarding saves. A pick from the directory names the servicer as the directory has it and links it; the
// contact email is the one typed, or the directory's. With no pick, the typed name and email stand as before.
export async function boardingServicer(input: { servicerId: string; servicerName: string; contactEmail: string; currentId?: string | null }) {
  const servicerId = String(input.servicerId || "").trim();
  if (!servicerId) return { error: null, servicerId: null, servicerName: input.servicerName, contactEmail: input.contactEmail } as const;
  const servicer = await prisma.servicer.findUnique({ where: { id: servicerId }, select: { id: true, name: true, contactEmail: true, active: true } });
  if (!servicer || (!servicer.active && servicer.id !== input.currentId)) return { error: "That servicer isn't on the directory. Pick another, or type the name." } as const;
  return { error: null, servicerId: servicer.id, servicerName: servicer.name, contactEmail: input.contactEmail || servicer.contactEmail } as const;
}
