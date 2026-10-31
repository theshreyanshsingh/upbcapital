"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { BrokerDealRole, DocType, FeeBasis } from "@prisma/client";
import { payoutNoteProblem, splitStates } from "@/lib/broker-fees";
import { endSessions, requireRole } from "@/lib/auth";
import { notify, notifyDesk } from "@/lib/email";
import { rescoreListing } from "@/lib/matching";
import { OFAC_DOWN_MESSAGE, OFAC_HOLD_MESSAGE, ofacHold, screenInBackground, screenListing, screenUser } from "@/lib/screening";
import { prisma } from "@/lib/prisma";
import { extensionOf, mimeFor, putBytes, safeBasename } from "@/lib/storage";
import { parseTapeBuffer, normalizeTapeRows } from "@/lib/tape";
import { suggestMapping } from "@/lib/tape-fields";
import { uploadProblem } from "@/lib/uploads";
import { US_STATES } from "@/lib/labels";
import { firstZodError, noteSchema, noteTitle } from "@/lib/validators";

async function brokerUser() {
  const user = await requireRole(["BROKER"]);
  const profile = await prisma.brokerProfile.findUnique({ where: { userId: user.id } });
  return { user, profile };
}

function cleanStates(raw: string) {
  const states = splitStates(raw);
  const bad = states.filter((state) => !(US_STATES as readonly string[]).includes(state));
  if (!states.length) return { error: "Name the states you cover. Use two-letter codes.", states: [] as string[] };
  if (bad.length) return { error: `Use two-letter state codes. ${bad.slice(0, 3).join(", ")} is not one.`, states: [] as string[] };
  return { error: "", states };
}

async function storeFile(file: FormDataEntryValue | null, label: string) {
  if (!(file instanceof File) || file.size <= 0) return { error: `Upload the ${label}.`, key: "", name: "", size: 0, mime: "" };
  const bytes = Buffer.from(await file.arrayBuffer());
  const problem = uploadProblem(file.name, bytes.length, bytes);
  if (problem) return { error: problem, key: "", name: "", size: 0, mime: "" };
  const ext = extensionOf(file.name);
  if (!ext) return { error: "That file type is not accepted.", key: "", name: "", size: 0, mime: "" };
  const key = `${crypto.randomUUID()}-${safeBasename(file.name)}`;
  await putBytes(key, bytes, mimeFor(ext, file.type || "application/octet-stream"));
  return { error: "", key, name: file.name.slice(0, 180), size: bytes.length, mime: mimeFor(ext, file.type || "application/octet-stream") };
}

export async function saveBrokerProfile(formData: FormData) {
  const { user, profile } = await brokerUser();
  if (!profile) await prisma.brokerProfile.create({ data: { userId: user.id } });
  const data: {
    company?: string;
    licenseType?: string;
    licenseNumber?: string;
    states?: string;
    payoutNote?: string;
    bio?: string;
    portraitKey?: string;
    w9Key?: string;
    w9Name?: string;
  } = {};

  if (formData.has("company")) {
    const company = String(formData.get("company") || "").trim();
    if (company.length < 2) return { error: "Enter the company name." };
    data.company = company.slice(0, 120);
  }
  if (formData.has("licenseType")) data.licenseType = String(formData.get("licenseType") || "").trim().slice(0, 80);
  if (formData.has("licenseNumber")) data.licenseNumber = String(formData.get("licenseNumber") || "").trim().slice(0, 40);
  if (formData.has("states")) {
    const parsed = cleanStates(String(formData.get("states") || ""));
    if (parsed.error) return { error: parsed.error };
    data.states = parsed.states.join(", ");
  }
  if (formData.has("payoutNote")) {
    const note = String(formData.get("payoutNote") || "").trim();
    const problem = payoutNoteProblem(note);
    if (problem) return { error: problem };
    data.payoutNote = note;
  }
  if (formData.has("bio")) data.bio = String(formData.get("bio") || "").trim().slice(0, 600);

  const portrait = formData.get("portrait");
  if (portrait instanceof File && portrait.size > 0) {
    if (!["png", "jpg", "jpeg", "webp"].includes(extensionOf(portrait.name) || "")) {
      return { error: "Use a PNG or JPG for the portrait." };
    }
    const stored = await storeFile(portrait, "portrait");
    if (stored.error) return { error: stored.error };
    data.portraitKey = stored.key;
  }
  const w9 = formData.get("w9");
  if (w9 instanceof File && w9.size > 0) {
    const stored = await storeFile(w9, "W-9");
    if (stored.error) return { error: stored.error };
    data.w9Key = stored.key;
    data.w9Name = stored.name;
  }

  await prisma.brokerProfile.update({ where: { userId: user.id }, data });
  if (data.company) {
    await prisma.user.update({ where: { id: user.id }, data: { companyName: data.company } });
  }
  revalidatePath("/broker");
  revalidatePath(`/brokers/${user.id}`);
  if (user.referralCode) revalidatePath(`/brokers/${user.referralCode}`);
  return { error: "" };
}

export async function markBrokerWelcomed() {
  const { user, profile } = await brokerUser();
  if (!profile?.company) redirect("/broker/onboarding");
  if (user.accountStatus !== "APPROVED") redirect("/broker");
  await prisma.brokerProfile.update({ where: { userId: user.id }, data: { welcomedAt: new Date() } });
  redirect("/broker");
}

export async function submitBrokerDeal(formData: FormData) {
  const { user, profile } = await brokerUser();
  if (user.accountStatus !== "APPROVED") return { error: "The desk approves your seat before you can file a deal." };
  if (!profile?.company || !profile.states || !profile.payoutNote) return { error: "Finish your profile before filing a deal." };
  if (!profile.w9Key) return { error: "Upload a W-9 on your profile before a fee can be owed." };

  const clientSellerName = String(formData.get("clientSellerName") || "").trim();
  const clientRelationship = String(formData.get("clientRelationship") || "").trim();
  const role = String(formData.get("brokerRole") || "");
  if (clientSellerName.length < 2) return { error: "Name the seller you represent." };
  if (clientRelationship.length < 2) return { error: "Say how you know this seller." };
  if (role !== "SELLER_BROKER" && role !== "AFFILIATE") return { error: "Choose seller's broker or referring affiliate." };
  if (role === "SELLER_BROKER" && !profile.licenseNumber) {
    return { error: "A seller's broker needs a license number on the profile. Affiliates can leave it blank." };
  }
  const authorization = await storeFile(formData.get("authorization"), "seller authorization");
  if (authorization.error) return { error: authorization.error };

  const kind = String(formData.get("kind") || "NOTE");
  let title = "";
  let loans: Record<string, unknown>[] = [];
  if (kind === "TAPE") {
    title = String(formData.get("title") || "").trim();
    if (title.length < 3) return { error: "Name the pool." };
    const tape = formData.get("tape");
    if (!(tape instanceof File) || tape.size <= 0) return { error: "Upload the tape." };
    const bytes = Buffer.from(await tape.arrayBuffer());
    const problem = uploadProblem(tape.name, bytes.length, bytes);
    if (problem) return { error: problem };
    const matrix = parseTapeBuffer(bytes, tape.name);
    const mapping = suggestMapping(matrix.headers);
    const parsed = normalizeTapeRows({ rows: matrix.rows, mapping, priceMode: "COLUMN" });
    if (parsed.errors.length) {
      return { error: parsed.errors.slice(0, 3).map((issue) => (issue.row ? `Row ${issue.row}: ${issue.message}` : issue.message)).join(" ") };
    }
    if (!parsed.loans.length) return { error: "That tape has no loans." };
    if (parsed.loans.length > 2000) return { error: "Tapes are limited to 2,000 loans." };
    loans = parsed.loans;
    const ext = extensionOf(tape.name);
    const storedName = `${crypto.randomUUID()}-${safeBasename(tape.name)}`;
    await putBytes(storedName, bytes, mimeFor(ext || "csv", tape.type || "text/csv"));
    const listing = await createBrokerListing({
      userId: user.id,
      userName: user.name,
      kind: "POOL",
      title,
      summary: String(formData.get("summary") || "").trim(),
      role,
      clientSellerName,
      clientRelationship,
      authorization,
      loans,
    });
    await prisma.document.create({
      data: {
        listingId: listing.id,
        type: "TAPE",
        originalName: tape.name.slice(0, 180),
        storedName,
        mime: mimeFor(ext || "csv", tape.type || "text/csv"),
        size: bytes.length,
      },
    });
    redirect(`/broker/deals/${listing.id}?notice=submitted`);
  }

  const parsed = noteSchema.safeParse({
    streetAddress: formData.get("streetAddress"),
    city: formData.get("city"),
    state: formData.get("state"),
    zip: formData.get("zip"),
    propertyType: formData.get("propertyType"),
    occupancy: formData.get("occupancy"),
    estimatedValue: formData.get("estimatedValue"),
    lienPosition: formData.get("lienPosition"),
    upb: formData.get("upb"),
    interestRate: formData.get("interestRate"),
    monthlyPi: formData.get("monthlyPi"),
    paymentStatus: formData.get("paymentStatus"),
    monthsDelinquent: formData.get("monthsDelinquent") || 0,
    lastPaidDate: formData.get("lastPaidDate") || "",
    originationDate: formData.get("originationDate") || "",
    maturityDate: formData.get("maturityDate") || "",
    askingPrice: formData.get("askingPrice"),
    foreclosureStatus: formData.get("foreclosureStatus") || "NONE",
    borrowerName: formData.get("borrowerName") || "",
    narrative: formData.get("narrative") || "",
  });
  if (!parsed.success) return { error: firstZodError(parsed.error) };
  const note = parsed.data;
  title = noteTitle(note);
  const listing = await createBrokerListing({
    userId: user.id,
    userName: user.name,
    kind: "SINGLE",
    title,
    summary: note.narrative,
    role,
    clientSellerName,
    clientRelationship,
    authorization,
    loans: [
      {
        streetAddress: note.streetAddress,
        city: note.city,
        state: note.state,
        zip: note.zip,
        propertyType: note.propertyType,
        occupancy: note.occupancy,
        estimatedValue: note.estimatedValue,
        lienPosition: note.lienPosition,
        upb: note.upb,
        interestRate: note.interestRate,
        monthlyPi: note.monthlyPi,
        paymentStatus: note.paymentStatus,
        monthsDelinquent: note.monthsDelinquent,
        lastPaidDate: note.lastPaidDate,
        originationDate: note.originationDate,
        maturityDate: note.maturityDate,
        askingPrice: note.askingPrice,
        foreclosureStatus: note.foreclosureStatus,
        borrowerName: note.borrowerName || "",
        memo: note.narrative || "",
      },
    ],
  });
  redirect(`/broker/deals/${listing.id}?notice=submitted`);
}

async function createBrokerListing(input: {
  userId: string;
  userName: string;
  kind: "SINGLE" | "POOL";
  title: string;
  summary: string;
  role: string;
  clientSellerName: string;
  clientRelationship: string;
  authorization: { key: string; name: string; size: number; mime: string };
  loans: Record<string, unknown>[];
}) {
  const listing = await prisma.listing.create({
    data: {
      kind: input.kind,
      sellerId: input.userId,
      brokerId: input.userId,
      brokerRole: input.role as BrokerDealRole,
      clientSellerName: input.clientSellerName,
      clientRelationship: input.clientRelationship,
      authorizationKey: input.authorization.key,
      authorizationName: input.authorization.name,
      status: "SUBMITTED",
      title: input.title,
      summary: input.summary,
      notes: { create: input.loans as never },
      documents: {
        create: {
          type: "OTHER" as DocType,
          originalName: input.authorization.name,
          storedName: input.authorization.key,
          mime: input.authorization.mime || "application/octet-stream",
          size: input.authorization.size || 1,
        },
      },
      reviews: {
        create: {
          authorId: input.userId,
          action: "COMMENT",
          comment: `Filed by ${input.userName} for ${input.clientSellerName}.`,
        },
      },
    },
  });
  await notifyDesk(
    `Broker file · ${input.title}`,
    `${input.userName} filed ${input.title} for ${input.clientSellerName} as ${input.role === "AFFILIATE" ? "a referring affiliate" : "seller's broker"}.`,
  );
  screenInBackground(() => screenListing(listing.id, input.userId));
  await rescoreListing(listing.id, false);
  revalidatePath("/admin/queue");
  revalidatePath("/broker");
  return listing;
}

function readBasis(raw: string): FeeBasis | null {
  if (raw === "PERCENT" || raw === "FLAT") return raw;
  return null;
}

export async function saveBrokerFeeOverride(formData: FormData) {
  await requireRole(["ADMIN"]);
  const userId = String(formData.get("userId") || "");
  const brokerBasis = readBasis(String(formData.get("brokerFeeBasis") || ""));
  const affiliateBasis = readBasis(String(formData.get("affiliateFeeBasis") || ""));
  const brokerValue = Number(formData.get("brokerFeeValue") || 0);
  const affiliateValue = Number(formData.get("affiliateFeeValue") || 0);
  if (!Number.isFinite(brokerValue) || !Number.isFinite(affiliateValue) || brokerValue < 0 || affiliateValue < 0) {
    redirect("/admin/brokers?error=Enter a fee of zero or more.");
  }
  if ((brokerBasis === "PERCENT" && brokerValue > 100) || (affiliateBasis === "PERCENT" && affiliateValue > 100)) {
    redirect("/admin/brokers?error=A percentage fee stays between 0 and 100.");
  }
  await prisma.brokerProfile.update({
    where: { userId },
    data: {
      brokerFeeBasis: brokerBasis,
      brokerFeeBps: brokerBasis === "PERCENT" ? Math.round(brokerValue * 100) : null,
      brokerFeeCents: brokerBasis === "FLAT" ? Math.round(brokerValue * 100) : null,
      affiliateFeeBasis: affiliateBasis,
      affiliateFeeBps: affiliateBasis === "PERCENT" ? Math.round(affiliateValue * 100) : null,
      affiliateFeeCents: affiliateBasis === "FLAT" ? Math.round(affiliateValue * 100) : null,
    },
  });
  redirect("/admin/brokers?notice=updated");
}

export async function setBrokerStatus(formData: FormData) {
  const admin = await requireRole(["ADMIN"]);
  const userId = String(formData.get("userId") || "");
  const status = String(formData.get("status") || "");
  if (status !== "APPROVED" && status !== "REJECTED" && status !== "PENDING") {
    redirect("/admin/brokers?error=Unknown status.");
  }
  if (status === "APPROVED") {
    if ((await screenUser(userId, "Broker approval")).unavailable) redirect(`/admin/brokers?error=${encodeURIComponent(OFAC_DOWN_MESSAGE)}`);
    if (await ofacHold({ userIds: [userId] })) redirect(`/admin/brokers?error=${encodeURIComponent(OFAC_HOLD_MESSAGE)}`);
  }
  const user = await prisma.user.update({ where: { id: userId }, data: { accountStatus: status } });
  if (status === "REJECTED") await endSessions(user.id);
  if (user.role === "BROKER") {
    await notify(user.email, status === "APPROVED" ? "Your seat is open" : "Your broker seat", status === "APPROVED"
      ? `${user.name}, the desk approved your seat. Sign in and the welcome is waiting.`
      : `${user.name}, the desk set your seat to ${status.toLowerCase()}.`);
  }
  await prisma.auditEvent.create({
    data: { actorId: admin.id, action: "broker.status", entityType: "User", entityId: user.id, detail: status },
  });
  redirect("/admin/brokers?notice=updated");
}

export async function markBrokerFeePaid(formData: FormData) {
  const admin = await requireRole(["ADMIN"]);
  const feeId = String(formData.get("feeId") || "");
  const fee = await prisma.brokerFee.findUnique({ where: { id: feeId }, include: { broker: true, closing: { include: { listing: true } } } });
  if (!fee || fee.status !== "OWED") redirect("/admin/payouts?error=That fee is not waiting.");
  await prisma.brokerFee.update({ where: { id: fee.id }, data: { status: "PAID", paidAt: new Date() } });
  await notify(fee.broker.email, "Broker fee marked paid", `The desk marked $${(fee.amountCents / 100).toFixed(2)} paid on ${fee.closing.listing.title}.`);
  await prisma.auditEvent.create({
    data: { actorId: admin.id, action: "broker.paid", entityType: "BrokerFee", entityId: fee.id, detail: fee.broker.email },
  });
  revalidatePath("/broker");
  redirect("/admin/payouts?notice=payment");
}
