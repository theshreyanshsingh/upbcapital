import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Prisma, SignatureRequest } from "@prisma/client";
import { canReadClosingFile } from "@/lib/acl";
import { audit } from "@/lib/audit";
import { TEMPLATE_KEYS, type TemplateKey } from "@/lib/closing-docs";
import { closingPacket } from "@/lib/closing-packet";
import { ENOTE_NO_PAPER } from "@/lib/enotes";
import { completeStepOnRecord, timelineStamp } from "@/lib/closing-service";
import { unset } from "@/lib/db-filters";
import { deskCan } from "@/lib/desk-roles";
import { notify, notifyDesk } from "@/lib/email";
import type { Tally } from "@/lib/jobs";
import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";
import { getBytes, putBytes } from "@/lib/storage";
import { cancelSignature, sendForSignature, signatureMode } from "@/lib/vendors";
import { namesOnTitle } from "@/lib/vesting";

// Closing papers sent for every party's signature, on a clock in hours from the send. In-app signing records each
// signer's typed name, time and address; a Dropbox Sign or DocuSign envelope reports back through
// /api/esign/webhook. One request per closing and form is live at a time, and a signed purchase agreement completes
// that closing step.

const HOUR = 60 * 60 * 1000;
export const DEFAULT_SIGN_HOURS = 48;
export const MAX_SIGN_HOURS = 720;
export const LIVE_STATUSES = ["SENT", "PARTIAL"];

export type SignerRole = "BUYER" | "SELLER" | "FUNDER" | "DESK";
// Times are ISO strings, since the signers live in one JSON field.
export type Signer = {
  role: SignerRole;
  userId?: string;
  name: string;
  email: string;
  signedAt?: string;
  signedName?: string;
  ip?: string;
  declinedAt?: string;
  declineReason?: string;
};

type Actor = { id: string; role: string; deskRole?: string | null };

// The consent each signer ticks before their typed name counts, as the ESIGN Act asks: the choice of paper, and
// the right to withdraw before signing.
export const ESIGN_CONSENT =
  "I agree to sign this document electronically. I intend my typed name to be my signature, with the same effect as signing on paper. I can ask the desk for a paper copy, or withdraw this consent before I sign, by writing on the closing thread.";

// Keyed by every form, so a new template can't reach the panel without a name.
const KIND_LABELS: Record<TemplateKey, string> = {
  PSA: "Purchase agreement",
  ASSIGNMENT: "Assignment",
  ALLONGE: "Allonge",
  LOST_NOTE_AFFIDAVIT: "Lost note affidavit",
  DEPOSIT_AGREEMENT: "Deposit agreement",
};
const STATUS_LABELS: Record<string, string> = {
  SENT: "Waiting for signatures",
  PARTIAL: "Partly signed",
  SIGNED: "Signed",
  DECLINED: "Declined",
  VOIDED: "Voided",
  EXPIRED: "Time ran out",
};
const ROLE_LABELS: Record<string, string> = { BUYER: "Buyer", SELLER: "Seller", FUNDER: "Group buyer", DESK: "Buyer, for the desk" };

export function kindLabel(kind: string) {
  return (KIND_LABELS as Record<string, string>)[kind] ?? kind;
}

export function statusLabel(status: string) {
  return STATUS_LABELS[status] ?? status;
}

export function roleLabel(role: string) {
  return ROLE_LABELS[role] ?? role;
}

export function vendorName(provider: string) {
  return provider === "dropbox-sign" ? "Dropbox Sign" : provider === "docusign" ? "DocuSign" : "the app";
}

export function isLive(status: string) {
  return LIVE_STATUSES.includes(status);
}

// Hours from the send for every party to sign. Missing or out of range means 48.
export function signHours(setting: number | null | undefined) {
  return setting != null && Number.isFinite(setting) && setting >= 1 && setting <= MAX_SIGN_HOURS ? Math.round(setting) : DEFAULT_SIGN_HOURS;
}

export function documentHash(pdf: Buffer) {
  return createHash("sha256").update(pdf).digest("hex");
}

// The bytes each party signs are kept under their own fingerprint, so the copy a signer opens is the one sent.
export function copyKey(closingId: string, hash: string) {
  return `signatures/${closingId}/${hash}.pdf`;
}

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

export function readSigners(value: unknown): Signer[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object")
    .map((row) => {
      const signer: Signer = { role: (text(row.role) || "BUYER") as SignerRole, name: text(row.name), email: text(row.email) };
      for (const key of ["userId", "signedAt", "signedName", "ip", "declinedAt", "declineReason"] as const) {
        if (text(row[key])) signer[key] = text(row[key]);
      }
      return signer;
    });
}

// Where a request stands from its signers alone. A decline ends it; the last signature finishes it.
export function requestStatus(signers: Signer[]): "SENT" | "PARTIAL" | "SIGNED" | "DECLINED" {
  if (signers.some((signer) => signer.declinedAt)) return "DECLINED";
  if (signers.length && signers.every((signer) => signer.signedAt)) return "SIGNED";
  return signers.some((signer) => signer.signedAt) ? "PARTIAL" : "SENT";
}

type Clocked = { status: string; sentAt: Date; dueAt: Date | null; remindedAt: Date | null };

// One reminder, once half the time to sign has passed.
export function reminderDue(request: Clocked, now = new Date()) {
  if (!isLive(request.status) || !request.dueAt || request.remindedAt) return false;
  const half = request.sentAt.getTime() + (request.dueAt.getTime() - request.sentAt.getTime()) / 2;
  return now.getTime() >= half && now.getTime() < request.dueAt.getTime();
}

export function expiryDue(request: Clocked, now = new Date()) {
  return isLive(request.status) && Boolean(request.dueAt && request.dueAt.getTime() <= now.getTime());
}

export function legalName(raw: string) {
  return raw.replace(/\s+/g, " ").trim().slice(0, 120);
}

export function signProblem(name: string, consent: boolean) {
  if (name.length < 2 || !/\p{L}/u.test(name)) return "Type your full legal name.";
  if (!consent) return "Tick the box to agree to sign electronically.";
  return null;
}

function appLink(path: string) {
  return `${process.env.NEXT_PUBLIC_APP_URL || ""}${path}`;
}

function signPath(request: { id: string; closingId: string }) {
  return `/closings/${request.closingId}/sign/${request.id}`;
}

function byEmail(signers: Signer[]) {
  return [...new Map(signers.filter((signer) => signer.email).map((signer) => [signer.email.toLowerCase(), signer])).values()];
}

function closedText(status: string) {
  if (status === "SIGNED") return "Every party has signed this already.";
  if (status === "DECLINED") return "A party declined this request, so it is closed. The desk will send a new copy if one is needed.";
  if (status === "EXPIRED") return "The time to sign has run out. The desk can send it again.";
  return "The desk withdrew this request. Sign the newest copy instead.";
}

// Writes one signer's line in place, only while the request is live and that line is still open. Two parties
// signing at once both land, a replayed vendor event changes nothing, and a voided request takes no signature.
// An open line has no time string; a raw command drops a `null` filter, so the check is on the type.
async function writeSigner(requestId: string, index: number, fields: Record<string, string>, userId?: string) {
  const at = (key: string) => `signers.${index}.${key}`;
  const open = { $not: { $type: "string" } };
  const result = (await prisma.$runCommandRaw({
    update: "SignatureRequest",
    updates: [
      {
        q: { _id: requestId, status: { $in: LIVE_STATUSES }, [at("signedAt")]: open, [at("declinedAt")]: open, ...(userId ? { [at("userId")]: userId } : {}) },
        u: { $set: Object.fromEntries(Object.entries(fields).map(([key, value]) => [at(key), value])) },
      },
    ],
  })) as { n?: unknown };
  return countOf(result.n) === 1;
}

function countOf(value: unknown) {
  if (value && typeof value === "object") {
    const wrapped = value as { $numberInt?: string; $numberLong?: string };
    return Number(wrapped.$numberInt ?? wrapped.$numberLong);
  }
  return Number(value);
}

// Ends a live request as voided or expired, and withdraws its envelope at the vendor unless the vendor ended it.
// Only the write that moves it off live does anything, so a signature or a second void that landed first wins.
async function endRequest(request: SignatureRequest, status: "VOIDED" | "EXPIRED", reason: string, now: Date, withdraw = true) {
  const claimed = await prisma.signatureRequest.updateMany({
    where: { id: request.id, status: { in: LIVE_STATUSES } },
    data: status === "VOIDED" ? { status, voidedAt: now, voidReason: reason.slice(0, 500) } : { status },
  });
  if (claimed.count !== 1) return false;
  if (withdraw && request.provider !== "in_app") await cancelSignature(request.provider, request.providerRef, reason);
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// Sending

type Packet = Extract<NonNullable<Awaited<ReturnType<typeof closingPacket>>>, { allowed: true }>;

// The seller and the buyer as the papers name them. A group's seats each sign for their share, and the desk buying
// for its own book signs as the buyer through the deal owner, or else the desk member who sent or bought it.
async function signersFor(packet: Packet, deskSignerId: string | null): Promise<Signer[]> {
  const { closing, inquiry, funders, names } = packet;
  const seller: Signer = { role: "SELLER", userId: closing.listing.sellerId, name: names.seller, email: closing.listing.seller.email };
  if (funders.length) {
    const vesting = await namesOnTitle(closing, inquiry?.buyerId ?? null, funders);
    return [seller, ...funders.map((funder) => ({ role: "FUNDER" as const, userId: funder.userId, name: vesting.funder(funder) || funder.user.name, email: funder.user.email }))];
  }
  if (inquiry) return [seller, { role: "BUYER", userId: inquiry.buyerId, name: names.buyer, email: inquiry.buyer.email }];
  const owner = closing.deskOwnerId
    ? await prisma.user.findUnique({ where: { id: closing.deskOwnerId }, select: { id: true, email: true, role: true, deskRole: true, deletedAt: true, accountStatus: true } })
    : null;
  const usable = owner && owner.role === "ADMIN" && !owner.deletedAt && owner.accountStatus === "APPROVED" && deskCan(owner, "closings");
  const desk = usable ? owner : deskSignerId ? await prisma.user.findUnique({ where: { id: deskSignerId }, select: { id: true, email: true } }) : null;
  return [seller, { role: "DESK", ...(desk ? { userId: desk.id } : {}), name: names.buyer, email: desk?.email ?? "" }];
}

// Builds the form from the closing, keeps the bytes under their fingerprint, and sends them to every party, through
// the vendor when one is configured. Sending a form again voids the copy still open for it.
export async function sendForSignatures(closingId: string, kind: TemplateKey, actor: Actor, now = new Date()) {
  if (actor.role !== "ADMIN" || !deskCan(actor, "closings")) return { error: "Only the closings desk sends papers for signature." } as const;
  return dispatch(closingId, kind, actor, now, actor.id);
}

// The purchase agreement goes out as an award opens the closing, so the hours to sign run from the award. It goes
// once per closing, sent by UPB rather than a desk member. A failure never undoes the award: it is logged, and the
// desk is told to send it from the closing. A desk purchase names who signs for the desk when there's no deal owner.
export async function sendOnAward(closingId: string, options: { deskSignerId?: string | null; now?: Date } = {}) {
  let problem: string;
  try {
    if (await prisma.signatureRequest.count({ where: { closingId, kind: "PSA" } })) return null;
    const sent = await dispatch(closingId, "PSA", null, options.now ?? new Date(), options.deskSignerId ?? null);
    if (sent.error === null) return sent.request;
    problem = sent.error;
  } catch (error) {
    problem = (error instanceof Error ? error.message : String(error)).split("\n")[0].slice(0, 200);
  }
  console.error(`[upb-signatures] the purchase agreement for closing ${closingId} wasn't sent at award: ${problem}`);
  try {
    const closing = await prisma.closing.findUnique({ where: { id: closingId }, select: { listing: { select: { title: true } } } });
    await notifyDesk(
      `Purchase agreement not sent · ${closing?.listing.title ?? "a new closing"}`,
      `The award opened the closing, but the purchase agreement didn't go out for signature. ${problem} Send it from the closing's Signatures panel. ${appLink(`/closings/${closingId}`)}`,
      { capability: "closings" },
    );
  } catch (error) {
    console.error(`[upb-signatures] the desk wasn't told about closing ${closingId}:`, error instanceof Error ? error.message : error);
  }
  return null;
}

// A null actor is UPB sending on its own, at an award.
async function dispatch(closingId: string, kind: TemplateKey, actor: Actor | null, now: Date, deskSignerId: string | null) {
  if (!(TEMPLATE_KEYS as readonly string[]).includes(kind)) return { error: "Choose a form to send." } as const;
  const packet = await closingPacket(closingId, kind, actor ?? { id: "", role: "ADMIN" });
  if (!packet) return { error: "That closing no longer exists." } as const;
  if (!packet.allowed) return { error: "eNote" in packet ? ENOTE_NO_PAPER : "Only the parties and the desk read this closing." } as const;
  if (packet.closing.status !== "OPEN") return { error: "This closing is already finished." } as const;
  const signers = await signersFor(packet, deskSignerId);
  if (signers.some((signer) => signer.role === "DESK" && !signer.userId)) return { error: "Name a deal owner who runs closings to sign for the desk." } as const;
  if (signers.some((signer) => !signer.email)) return { error: "A party on this closing has no email on file, so the papers can't reach them." } as const;
  const hash = documentHash(packet.pdf);
  await putBytes(copyKey(closingId, hash), packet.pdf, "application/pdf");
  const hours = signHours((await getSettings()).psaSignHours);
  const dueAt = new Date(now.getTime() + hours * HOUR);
  const title = packet.closing.listing.title;
  const label = kindLabel(kind);
  let provider = "in_app";
  let providerRef = "";
  let fellBack = false;
  if (signatureMode() !== "mock") {
    const sent = await sendForSignature({
      title: `${packet.template.title} · ${title}`,
      signers: signers.map((signer) => ({ name: signer.name, email: signer.email })),
      pdf: packet.pdf,
      kind: kind.toLowerCase() as "psa" | "assignment" | "allonge",
    });
    // A vendor that refused the file, or answered with no envelope to match its events to, leaves signing in the app.
    if (sent.provider !== "mock" && sent.id && sent.id !== "sent") {
      provider = sent.provider;
      providerRef = sent.id;
    } else fellBack = true;
  }
  const request = await prisma.signatureRequest.create({
    data: { closingId, kind, provider, providerRef, status: "SENT", signers: signers as unknown as Prisma.InputJsonValue, documentHash: hash, dueAt, sentAt: now, createdById: actor?.id ?? null },
  });
  // Every older copy of this form still open is void. Newest wins, so two desk members sending at once leave one.
  const older = await prisma.signatureRequest.findMany({
    where: { closingId, kind, status: { in: LIVE_STATUSES }, id: { not: request.id }, OR: [{ sentAt: { lt: now } }, { sentAt: now, id: { lt: request.id } }] },
  });
  const replaced: SignatureRequest[] = [];
  for (const old of older) if (await endRequest(old, "VOIDED", "Sent again.", now)) replaced.push(old);
  const link = appLink(signPath(request));
  const how = provider === "in_app" ? `Read it and sign here: ${link}` : `${vendorName(provider)} will email you a link to sign it. Where every party stands: ${link}`;
  const again = replaced.length ? " This copy replaces the one sent earlier, so sign this one." : "";
  const sender = actor ? `The desk sent the ${label.toLowerCase()} for ${title}` : `The award opened the closing for ${title}, so the ${label.toLowerCase()} went out`;
  for (const signer of byEmail(signers)) {
    await notify(signer.email, `Sign the ${label.toLowerCase()} · ${title}`, `${sender} to every party for signature. Every party signs by ${timelineStamp(dueAt)}.${again} ${how}`);
  }
  await audit(
    actor?.id ?? null,
    "SIGNATURE_SENT",
    "closing",
    closingId,
    `${actor ? "" : "Sent automatically at the award. "}${kind} to ${signers.map((signer) => roleLabel(signer.role).toLowerCase()).join(", ")} through ${vendorName(provider)}${fellBack ? ` after ${vendorName(signatureMode())} refused it` : ""}. Due ${dueAt.toISOString()}. SHA-256 ${hash}.${replaced.length ? ` Voided ${replaced.map((row) => row.id).join(", ")}.` : ""}`,
  );
  return { error: null, request, fellBack, replaced: replaced.length } as const;
}

// ---------------------------------------------------------------------------------------------------------------
// Signing, declining and voiding

// The request's status once a line changes. The write that finishes it notifies the parties and, for the purchase
// agreement, completes that closing step.
async function settleRequest(requestId: string, actorId: string | null, now: Date) {
  const request = await prisma.signatureRequest.findUnique({ where: { id: requestId } });
  if (!request || !isLive(request.status)) return request?.status ?? null;
  const signers = readSigners(request.signers);
  const status = requestStatus(signers);
  if (status === "SIGNED") {
    const claimed = await prisma.signatureRequest.updateMany({ where: { id: request.id, status: { in: LIVE_STATUSES } }, data: { status: "SIGNED", completedAt: now } });
    if (claimed.count === 1) await onSigned(request, signers, actorId);
    return "SIGNED";
  }
  if (status === "PARTIAL" && request.status === "SENT") await prisma.signatureRequest.updateMany({ where: { id: request.id, status: "SENT" }, data: { status: "PARTIAL" } });
  return status;
}

async function onSigned(request: SignatureRequest, signers: Signer[], actorId: string | null) {
  const closing = await prisma.closing.findUnique({ where: { id: request.closingId }, select: { listing: { select: { title: true } } } });
  const title = closing?.listing.title ?? "the closing";
  const label = kindLabel(request.kind);
  const link = appLink(`/closings/${request.closingId}`);
  const line = `Every party signed the ${label.toLowerCase()} for ${title}.`;
  // The signed purchase agreement completes its step the way the desk's form does, which tells the parties.
  const blocked =
    request.kind === "PSA"
      ? await completeStepOnRecord(request.closingId, "PURCHASE_AGREEMENT", {
          actorId,
          note: `Signed electronically by every party. Document SHA-256 ${request.documentHash.slice(0, 16)}.`,
          message: `${line} The purchase agreement step is complete. ${link}`,
        })
      : "";
  if (blocked !== null) for (const signer of byEmail(signers)) await notify(signer.email, `Signed · ${label} · ${title}`, `${line} ${link}`);
  const held = blocked && blocked !== "That step is already marked complete." ? ` The purchase agreement step stayed open: ${blocked}` : "";
  await notifyDesk(`Signed · ${label} · ${title}`, `${line}${held} ${link}`, { capability: "closings" });
  await audit(actorId, "SIGNATURE_COMPLETE", "closing", request.closingId, `${request.kind} signed by ${signers.length} parties. SHA-256 ${request.documentHash}.`);
}

// The request ends at the first decline. Only the write that ends it tells the desk.
async function onDeclined(request: SignatureRequest, signer: Signer | null, reason: string, actorId: string | null) {
  const claimed = await prisma.signatureRequest.updateMany({ where: { id: request.id, status: { in: LIVE_STATUSES } }, data: { status: "DECLINED" } });
  if (claimed.count !== 1) return false;
  const closing = await prisma.closing.findUnique({ where: { id: request.closingId }, select: { listing: { select: { title: true } } } });
  const title = closing?.listing.title ?? "the closing";
  const label = kindLabel(request.kind);
  const who = signer ? `${signer.name} (${roleLabel(signer.role).toLowerCase()})` : "A party";
  const why = reason ? ` Reason: ${reason}` : "";
  await notifyDesk(
    `Signature declined · ${title}`,
    `${who} declined to sign the ${label.toLowerCase()} for ${title}.${why} The closing stays open. Talk to the parties, then send a corrected copy or cancel the closing. ${appLink(`/closings/${request.closingId}`)}`,
    { capability: "closings" },
  );
  const others = byEmail(readSigners(request.signers)).filter((row) => row.email.toLowerCase() !== signer?.email.toLowerCase());
  for (const row of others) await notify(row.email, `Signature declined · ${title}`, `${who} declined to sign the ${label.toLowerCase()} for ${title}, so that request is closed. The desk will be in touch about what comes next.`);
  await audit(actorId, "SIGNATURE_DECLINED", "closing", request.closingId, `${request.kind}: ${signer ? `${signer.role} ${signer.name}` : "a party"}.${why}`);
  return true;
}

type Answer = { error: string } | { error: null; status: string | null };

async function ownLine(requestId: string, actor: { id: string }, now: Date) {
  const request = await prisma.signatureRequest.findUnique({ where: { id: requestId } });
  if (!request) return { error: "That request no longer exists." } as const;
  const signers = readSigners(request.signers);
  if (!signers.some((signer) => signer.userId === actor.id)) return { error: "Only the parties named on this request can sign it." } as const;
  if (!isLive(request.status)) return { error: closedText(request.status) } as const;
  const closing = await prisma.closing.findUnique({ where: { id: request.closingId }, select: { status: true } });
  if (closing?.status !== "OPEN") return { error: "This closing is already finished, so there's nothing to sign." } as const;
  if (request.provider !== "in_app") return { error: `Sign from the email ${vendorName(request.provider)} sent you.` } as const;
  const index = signers.findIndex((signer) => signer.userId === actor.id && !signer.signedAt && !signer.declinedAt);
  if (index < 0) return { error: "You already answered this request." } as const;
  if (request.dueAt && request.dueAt.getTime() <= now.getTime()) return { error: closedText("EXPIRED") } as const;
  return { error: null, request, signers, index } as const;
}

// Only the signer's own account signs their line, with their full legal name and consent to sign electronically.
export async function signRequest(requestId: string, actor: { id: string }, input: { name: string; consent: boolean; ip: string }, now = new Date()): Promise<Answer> {
  const line = await ownLine(requestId, actor, now);
  if (line.error !== null) return line;
  const name = legalName(input.name);
  const problem = signProblem(name, input.consent);
  if (problem) return { error: problem };
  const wrote = await writeSigner(line.request.id, line.index, { signedAt: now.toISOString(), signedName: name, ip: input.ip.slice(0, 64) }, actor.id);
  if (!wrote) return { error: "This request changed a moment ago. Reload it and try again." };
  await audit(actor.id, "SIGNATURE_SIGNED", "closing", line.request.closingId, `${line.request.kind} ${line.signers[line.index].role}: signed as ${name}.`);
  return { error: null, status: await settleRequest(line.request.id, actor.id, now) };
}

export async function declineRequest(requestId: string, actor: { id: string }, reason: string, now = new Date()): Promise<Answer> {
  const line = await ownLine(requestId, actor, now);
  if (line.error !== null) return line;
  const why = reason.replace(/\s+/g, " ").trim().slice(0, 500);
  if (why.length < 3) return { error: "Say why you're declining, in a few words. The desk reads it." };
  const wrote = await writeSigner(line.request.id, line.index, { declinedAt: now.toISOString(), declineReason: why }, actor.id);
  if (!wrote) return { error: "This request changed a moment ago. Reload it and try again." };
  await onDeclined(line.request, line.signers[line.index], why, actor.id);
  return { error: null, status: "DECLINED" };
}

export async function voidRequest(requestId: string, closingId: string, actor: Actor, reason: string, now = new Date()) {
  if (actor.role !== "ADMIN" || !deskCan(actor, "closings")) return { error: "Only the closings desk voids a signature request." } as const;
  const why = reason.replace(/\s+/g, " ").trim().slice(0, 500);
  if (why.length < 3) return { error: "Say why the request is being voided." } as const;
  const request = await prisma.signatureRequest.findUnique({ where: { id: requestId } });
  if (!request || request.closingId !== closingId) return { error: "That request no longer exists." } as const;
  if (!(await endRequest(request, "VOIDED", why, now))) return { error: "This request is already finished." } as const;
  const closing = await prisma.closing.findUnique({ where: { id: closingId }, select: { listing: { select: { title: true } } } });
  const title = closing?.listing.title ?? "the closing";
  const label = kindLabel(request.kind).toLowerCase();
  for (const signer of byEmail(readSigners(request.signers))) {
    await notify(signer.email, `Signature request withdrawn · ${title}`, `The desk withdrew the ${label} sent for signature on ${title}. Reason: ${why} Don't sign that copy. The desk sends a new one if it's needed.`);
  }
  await audit(actor.id, "SIGNATURE_VOIDED", "closing", closingId, `${request.kind}: ${why}`);
  return { error: null } as const;
}

// A canceled closing takes its papers with it: every request still out is void at once, and each vendor envelope is
// withdrawn. The cancel notice already told the parties, so this sends nothing more.
export async function voidOpenRequests(closingId: string, reason: string, now = new Date()) {
  const open = await prisma.signatureRequest.findMany({ where: { closingId, status: { in: LIVE_STATUSES } } });
  let voided = 0;
  for (const request of open) {
    if (!(await endRequest(request, "VOIDED", reason, now))) continue;
    voided += 1;
    await audit(null, "SIGNATURE_VOIDED", "closing", closingId, `${request.kind}: ${reason}`);
  }
  return voided;
}

// ---------------------------------------------------------------------------------------------------------------
// Vendor events

export type VendorSigner = { email?: string; index?: number; name?: string; signedAt?: Date; declinedAt?: Date; declineReason?: string };
export type VendorEvent = { provider: "dropbox-sign" | "docusign"; ref: string; at: Date; signers: VendorSigner[]; allSigned?: boolean; declined?: boolean; voided?: boolean };

function matchSigner(signers: Signer[], update: VendorSigner) {
  const email = update.email?.toLowerCase();
  const byMail = email ? signers.findIndex((signer) => signer.email.toLowerCase() === email) : -1;
  if (byMail >= 0) return byMail;
  return update.index != null && update.index >= 0 && update.index < signers.length ? update.index : -1;
}

// A verified vendor event, matched to its request by the envelope reference. Each line changes once, so a replayed
// or out-of-order delivery leaves the request as it was. An event for no request of ours (an NDA envelope on the
// same account) is acknowledged and ignored.
export async function applyVendorEvent(event: VendorEvent, now = new Date()) {
  const request = event.ref ? await prisma.signatureRequest.findFirst({ where: { provider: event.provider, providerRef: event.ref } }) : null;
  if (!request) return { matched: false, status: null } as const;
  if (!isLive(request.status)) return { matched: true, status: request.status } as const;
  const signers = readSigners(request.signers);
  let decliner: Signer | null = null;
  let declineReason = "";
  const signed = new Set<number>();
  for (const update of event.signers) {
    const index = matchSigner(signers, update);
    if (index < 0) continue;
    if (update.declinedAt) {
      const why = (update.declineReason || "").replace(/\s+/g, " ").trim().slice(0, 500);
      if (await writeSigner(request.id, index, { declinedAt: update.declinedAt.toISOString(), ...(why ? { declineReason: why } : {}) })) {
        decliner = signers[index];
        declineReason = why;
      }
    } else if (update.signedAt && !signed.has(index)) {
      signed.add(index);
      if (await writeSigner(request.id, index, { signedAt: update.signedAt.toISOString(), signedName: legalName(update.name || signers[index].name) })) {
        await audit(null, "SIGNATURE_SIGNED", "closing", request.closingId, `${request.kind} ${signers[index].role}: signed through ${vendorName(event.provider)}.`);
      }
    }
  }
  if (event.allSigned && !decliner) {
    for (const [index, signer] of signers.entries()) {
      if (signer.signedAt || signer.declinedAt || signed.has(index)) continue;
      await writeSigner(request.id, index, { signedAt: event.at.toISOString(), signedName: signer.name });
    }
  }
  if (decliner || event.declined) {
    await onDeclined(request, decliner, declineReason, null);
    return { matched: true, status: "DECLINED" } as const;
  }
  if (event.voided && (await endRequest(request, "VOIDED", `Voided at ${vendorName(event.provider)}.`, now, false))) {
    await notifyDesk(`Signature request voided · ${vendorName(event.provider)}`, `The envelope for the ${kindLabel(request.kind).toLowerCase()} was voided at ${vendorName(event.provider)}. Send it again from the closing if it's still needed. ${appLink(`/closings/${request.closingId}`)}`, { capability: "closings" });
    await audit(null, "SIGNATURE_VOIDED", "closing", request.closingId, `${request.kind}: voided at ${vendorName(event.provider)}.`);
    return { matched: true, status: "VOIDED" } as const;
  }
  return { matched: true, status: await settleRequest(request.id, null, now) } as const;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function list(value: unknown) {
  return Array.isArray(value) ? value.map(record) : [];
}

function dateOf(value: unknown) {
  const date = typeof value === "string" && value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

function unixDate(value: unknown) {
  const seconds = Number(value);
  return value != null && value !== "" && Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : null;
}

// Dropbox Sign posts its event as a form with one `json` field. A plain JSON body reads the same.
export async function dropboxPayload(raw: Buffer, contentType: string | null) {
  try {
    const type = (contentType || "").toLowerCase();
    let body: string | null;
    if (type.includes("multipart/form-data")) {
      const field = (await new Response(new Uint8Array(raw), { headers: { "content-type": contentType || "" } }).formData()).get("json");
      body = typeof field === "string" ? field : null;
    } else if (type.includes("application/x-www-form-urlencoded")) {
      body = new URLSearchParams(raw.toString("utf8")).get("json");
    } else {
      body = raw.toString("utf8");
    }
    const parsed = body ? (JSON.parse(body) as unknown) : null;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function dropboxSignEvent(payload: Record<string, unknown>): VendorEvent | null {
  const event = record(payload.event);
  const request = record(payload.signature_request);
  const ref = text(request.signature_request_id);
  // The callback test Dropbox Sign sends on setup names no request.
  if (!ref) return null;
  const type = text(event.event_type);
  const at = unixDate(event.event_time) ?? new Date();
  const signers = list(request.signatures).flatMap((signature): VendorSigner[] => {
    const status = text(signature.status_code);
    const who = { email: text(signature.signer_email_address), name: text(signature.signer_name) };
    if (status === "signed") return [{ ...who, signedAt: unixDate(signature.signed_at) ?? at }];
    if (status === "declined") return [{ ...who, declinedAt: at, declineReason: text(signature.decline_reason) }];
    return [];
  });
  return {
    provider: "dropbox-sign",
    ref,
    at,
    signers,
    allSigned: type === "signature_request_all_signed" || request.is_complete === true,
    declined: type === "signature_request_declined" || request.is_declined === true,
    voided: type === "signature_request_canceled",
  };
}

// A DocuSign Connect JSON event. With recipient data included, each signer's status comes with it; without it, a
// recipient event names the recipient by its place on the envelope.
export function docuSignEvent(payload: Record<string, unknown>): VendorEvent | null {
  const data = record(payload.data);
  const ref = text(data.envelopeId);
  if (!ref) return null;
  const type = text(payload.event);
  const at = dateOf(payload.generatedDateTime) ?? new Date();
  const summary = record(record(record(data.envelopeSummary).recipients)).signers;
  const place = (value: unknown) => (Number.isFinite(Number(value)) && text(value) ? Number(value) - 1 : undefined);
  let signers: VendorSigner[] = [];
  if (Array.isArray(summary)) {
    signers = list(summary).flatMap((signer): VendorSigner[] => {
      const status = text(signer.status).toLowerCase();
      const who = { email: text(signer.email), name: text(signer.name), index: place(signer.recipientId) };
      if (status === "completed" || status === "signed") return [{ ...who, signedAt: dateOf(signer.signedDateTime) ?? at }];
      if (status === "declined") return [{ ...who, declinedAt: dateOf(signer.declinedDateTime) ?? at, declineReason: text(signer.declinedReason) }];
      return [];
    });
  } else if (type === "recipient-completed" && place(data.recipientId) != null) {
    signers = [{ index: place(data.recipientId), signedAt: at }];
  } else if (type === "recipient-declined" && place(data.recipientId) != null) {
    signers = [{ index: place(data.recipientId), declinedAt: at }];
  }
  return { provider: "docusign", ref, at, signers, allSigned: type === "envelope-completed", declined: type === "envelope-declined", voided: type === "envelope-voided" };
}

function sameText(given: string, expected: string) {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Dropbox Sign signs each event with the hex HMAC-SHA256 of event_time followed by event_type, keyed with the API key.
export function dropboxSignHash(eventTime: string, eventType: string, apiKey: string) {
  return createHmac("sha256", apiKey).update(`${eventTime}${eventType}`).digest("hex");
}

export function verifyDropboxSign(event: unknown, apiKey: string | null | undefined) {
  if (!apiKey) return false;
  const fields = record(event);
  const time = typeof fields.event_time === "number" ? String(fields.event_time) : text(fields.event_time);
  const type = text(fields.event_type);
  const hash = text(fields.event_hash).toLowerCase();
  return Boolean(time && type && hash) && sameText(hash, dropboxSignHash(time, type, apiKey));
}

// DocuSign Connect sends the base64 HMAC-SHA256 of the raw body, keyed with the Connect secret, in
// X-DocuSign-Signature-1, and one more header for each further key while keys rotate. Any one matching is enough.
export function docuSignSignature(raw: Buffer | string, secret: string) {
  return createHmac("sha256", secret).update(raw).digest("base64");
}

export function verifyDocuSign(raw: Buffer | string, signatures: (string | null | undefined)[], secret: string | null | undefined) {
  if (!secret) return false;
  const expected = docuSignSignature(raw, secret);
  return signatures.some((value) => typeof value === "string" && value.trim() !== "" && sameText(value.trim(), expected));
}

// ---------------------------------------------------------------------------------------------------------------
// The clock

// Reminds the parties still to sign once, halfway through, and closes a request at its due time. The closing stays
// open: the desk decides whether to send again or cancel. `closingIds` narrows the run, so a test reads only its own.
export async function signatureClock(now = new Date(), options: { closingIds?: string[] } = {}): Promise<Tally> {
  const { eachItem } = await import("@/lib/jobs");
  const scope = options.closingIds ? { closingId: { in: options.closingIds } } : {};
  const include = { closing: { select: { status: true, listing: { select: { title: true } } } } } as const;
  const [due, running] = await Promise.all([
    prisma.signatureRequest.findMany({ where: { status: { in: LIVE_STATUSES }, dueAt: { lte: now }, ...scope }, include }),
    prisma.signatureRequest.findMany({ where: { status: { in: LIVE_STATUSES }, dueAt: { gt: now }, ...unset("remindedAt"), ...scope }, include }),
  ]);
  // A closing that finished or was canceled with papers still out takes them with it, and nobody is reminded.
  const open = (request: (typeof due)[number]) => request.closing.status === "OPEN";
  const finished = await eachItem("signature cleanup", [...due, ...running].filter((request) => !open(request)), (request) => `signature ${request.id}`, async (request) => {
    await endRequest(request, "VOIDED", "The closing is finished.", now);
    return false;
  });
  const expired = await eachItem("signature expiry", due.filter(open), (request) => `signature ${request.id}`, async (request) => {
    if (!(await endRequest(request, "EXPIRED", "The time to sign ran out.", now))) return false;
    const signers = readSigners(request.signers);
    const waiting = signers.filter((signer) => !signer.signedAt);
    const title = request.closing.listing.title;
    await audit(null, "SIGNATURE_EXPIRED", "closing", request.closingId, `${request.kind}: ${signers.length - waiting.length} of ${signers.length} signed by ${request.dueAt?.toISOString()}.`);
    await notifyDesk(
      `Signature time ran out · ${title}`,
      `The time to sign the ${kindLabel(request.kind).toLowerCase()} for ${title} ran out at ${request.dueAt ? timelineStamp(request.dueAt) : "its due time"}. ${signers.length - waiting.length} of ${signers.length} parties signed.${waiting.length ? ` Still waiting on ${waiting.map((signer) => signer.name).join(", ")}.` : ""} The closing stays open. Send it again or write the parties. ${appLink(`/closings/${request.closingId}`)}`,
      { capability: "closings" },
    );
    return true;
  });
  const reminded = await eachItem("signature reminder", running.filter((request) => open(request) && reminderDue(request, now)), (request) => `signature ${request.id}`, async (request) => {
    const claim = await prisma.signatureRequest.updateMany({ where: { id: request.id, status: { in: LIVE_STATUSES }, ...unset("remindedAt") }, data: { remindedAt: now } });
    if (claim.count !== 1) return false;
    const waiting = byEmail(readSigners(request.signers).filter((signer) => !signer.signedAt && !signer.declinedAt));
    const title = request.closing.listing.title;
    const how = request.provider === "in_app" ? `Sign here: ${appLink(signPath(request))}` : `Sign from the email ${vendorName(request.provider)} sent you.`;
    for (const signer of waiting) {
      await notify(signer.email, `Reminder: sign the ${kindLabel(request.kind).toLowerCase()} · ${title}`, `Half the time to sign has passed. Every party signs by ${request.dueAt ? timelineStamp(request.dueAt) : "the due time"}. ${how}`);
    }
    return waiting.length > 0;
  });
  return { sent: expired.sent + reminded.sent, failed: finished.failed + expired.failed + reminded.failed, error: finished.error || expired.error || reminded.error };
}

// ---------------------------------------------------------------------------------------------------------------
// Reading

// The copy sent for signature, for the packet route. Null when there is none or the bytes no longer match their
// fingerprint; `allowed` false when the viewer may not read the closing.
export async function sentCopy(closingId: string, requestId: string, viewer: { id: string; role: string }) {
  const request = await prisma.signatureRequest.findFirst({ where: { id: requestId, closingId } });
  const closing = request
    ? await prisma.closing.findUnique({ where: { id: closingId }, select: { inquiryId: true, listing: { select: { sellerId: true } }, funders: { select: { userId: true } } } })
    : null;
  if (!request || !closing) return null;
  const inquiry = closing.inquiryId ? await prisma.inquiry.findUnique({ where: { id: closing.inquiryId }, select: { buyerId: true } }) : null;
  const allowed = canReadClosingFile({ role: viewer.role, userId: viewer.id, sellerId: closing.listing.sellerId, buyerId: inquiry?.buyerId ?? null, funderIds: closing.funders.map((row) => row.userId) });
  if (!allowed) return { allowed: false } as const;
  const pdf = await getBytes(copyKey(closingId, request.documentHash)).catch(() => null);
  if (!pdf || documentHash(pdf) !== request.documentHash) return null;
  return { allowed: true, pdf, kind: request.kind } as const;
}

export type SignerView = { role: string; name: string; state: "signed" | "declined" | "waiting"; at: Date | null; mine: boolean; signedName: string; ip: string; declineReason: string };
export type RequestView = {
  id: string;
  kind: string;
  provider: string;
  status: string;
  live: boolean;
  sentAt: Date;
  dueAt: Date | null;
  completedAt: Date | null;
  voidReason: string;
  documentHash: string;
  signers: SignerView[];
  canSign: boolean;
  mine: boolean;
};

export function requestView(request: SignatureRequest, viewer: { id: string; role: string }, now = new Date()): RequestView {
  const desk = viewer.role === "ADMIN";
  const live = isLive(request.status) && !expiryDue(request, now);
  const signers = readSigners(request.signers).map((signer): SignerView => {
    const mine = Boolean(signer.userId) && signer.userId === viewer.id;
    const state = signer.declinedAt ? "declined" : signer.signedAt ? "signed" : "waiting";
    return {
      role: signer.role,
      name: signer.name,
      state,
      at: dateOf(signer.signedAt ?? signer.declinedAt),
      mine,
      // The desk reads each line's record. A party reads their own, and the others' state.
      signedName: desk || mine ? (signer.signedName ?? "") : "",
      ip: desk ? (signer.ip ?? "") : "",
      declineReason: desk || mine ? (signer.declineReason ?? "") : "",
    };
  });
  const open = signers.find((signer) => signer.mine && signer.state === "waiting");
  return {
    id: request.id,
    kind: request.kind,
    provider: request.provider,
    status: live || !isLive(request.status) ? request.status : "EXPIRED",
    live,
    sentAt: request.sentAt,
    dueAt: request.dueAt,
    completedAt: request.completedAt,
    voidReason: request.voidReason ?? "",
    documentHash: request.documentHash,
    signers,
    canSign: live && request.provider === "in_app" && Boolean(open),
    mine: signers.some((signer) => signer.mine),
  };
}

// What a closing's signature panel shows: every request to the desk, newest first, and to a party the newest
// request for each form.
export async function signatureView(closingId: string, viewer: { id: string; role: string }, now = new Date()) {
  const requests = await prisma.signatureRequest.findMany({ where: { closingId }, orderBy: { sentAt: "desc" }, take: 30 });
  const shown = viewer.role === "ADMIN" ? requests : requests.filter((request, index) => requests.findIndex((row) => row.kind === request.kind) === index);
  return shown.map((request) => requestView(request, viewer, now));
}
