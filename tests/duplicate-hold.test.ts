import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { Role } from "@prisma/client";
import { diligenceChecklist, diligenceGateMessage } from "../lib/diligence-checklist";
import { clearDuplicates, DUPLICATE_COMMENT, DUPLICATE_HOLD, duplicateGateMessage, duplicateHold, duplicateKeys, duplicatesFor, flagDuplicates } from "../lib/duplicates";
import { chainOfTitle, isMers } from "../lib/loan-file";
import { prisma } from "../lib/prisma";
import { DESK_DENIED } from "../lib/staff";

// Mail goes to the log and screens to the short local list, whatever the shared .env says.
for (const key of ["RESEND_API_KEY", "SMTP_HOST", "DESK_EMAIL", "OFAC_SDN_URL", "OFAC_API_URL", "OFAC_API_KEY", "UPB_RELEASE"]) {
  process.env[key] = "";
}

test.after(async () => {
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------------------------------------------
// E3: the assignment chain in the diligence set

const SELLER = "Gulf Notes LLC";
const MIN = "100123400000000017";
const loan = (id: string, extra: Record<string, unknown> = {}) => ({ id, streetAddress: `${id} Main`, city: "Tampa", state: "FL", lienPosition: "FIRST", paymentStatus: "NON_PERFORMING", ...extra });
const assignment = (noteId: string, sequence: number, from: string, to: string, status = "PRESENT") => ({
  id: `${noteId}-assignment-${sequence}`,
  noteId,
  kind: "ASSIGNMENT",
  status,
  sequence,
  detail: from || to ? `${from} → ${to}` : "",
});
const checkedMin = (value = MIN) => ({ mersMin: { at: "2026-11-01T00:00:00.000Z", by: "desk", source: "Mortgage or deed of trust", value } });

function assignments(notes: ReturnType<typeof loan>[], collateral: ReturnType<typeof assignment>[], extra: Record<string, unknown> = {}) {
  const set = diligenceChecklist({ kind: notes.length > 1 ? "POOL" : "SINGLE", notes, collateral, documents: [], holder: SELLER, release: false, ...extra });
  return { set, line: set.lines.find((row) => row.key === "ASSIGNMENTS")! };
}

test("a broken assignment chain holds the diligence set, as a broken endorsement chain does", () => {
  // Recorded to someone who isn't the seller.
  const wrongEnd = assignments([loan("a")], [assignment("a", 1, "First Bank", "Other Fund")]);
  assert.equal(wrongEnd.line.label, "Assignment chain");
  assert.equal(wrongEnd.line.state, "missing");
  assert.match(diligenceGateMessage(wrongEnd.set, "SINGLE") ?? "", /Assignment chain/);
  // A gap between two links.
  assert.equal(assignments([loan("a")], [assignment("a", 1, "First Bank", "Coastal Capital"), assignment("a", 2, "Harbor Fund", SELLER)]).line.state, "missing");
  // A link the desk marked missing is a break too, though the chain panel counts it as a collateral defect.
  assert.equal(assignments([loan("a")], [assignment("a", 1, "First Bank", "Coastal Capital"), assignment("a", 2, "Coastal Capital", SELLER, "MISSING")]).line.state, "missing");
  // A link that names one party.
  assert.equal(assignments([loan("a")], [assignment("a", 1, "First Bank", "")]).line.state, "missing");
  // Nothing recorded and no assignment on file.
  assert.equal(assignments([loan("a")], []).line.state, "missing");

  // An unbroken chain to the seller, a recorded assignment on file before the desk keys the chain, and a line the desk
  // marked not required (the seller originated the loan) each count.
  assert.equal(assignments([loan("a")], [assignment("a", 1, "First Bank", "Coastal Capital"), assignment("a", 2, "Coastal Capital", SELLER)]).line.state, "complete");
  assert.equal(assignments([loan("a")], [], { documents: [{ type: "ASSIGNMENT", noteId: null, originalName: "aom.pdf" }] }).line.state, "complete");
  assert.equal(assignments([loan("a")], [assignment("a", 1, "", "", "NOT_REQUIRED")]).line.state, "complete");
  // A document on file doesn't outweigh a chain the desk recorded with a break.
  assert.equal(assignments([loan("a")], [assignment("a", 1, "First Bank", "Other Fund")], { documents: [{ type: "ASSIGNMENT", noteId: null, originalName: "aom.pdf" }] }).line.state, "missing");
});

test("compliance's waiver passes a broken assignment chain, and buyers read it", () => {
  const notes = [loan("a"), loan("b")];
  const collateral = [assignment("a", 1, "First Bank", "Other Fund"), assignment("b", 1, "First Bank", SELLER)];
  const held = assignments(notes, collateral);
  assert.equal(held.set.complete, false);
  assert.deepEqual(held.line.missing.map((gap) => gap.noteId), ["a"]);
  const waivers = { "ASSIGNMENTS:a": { by: "desk", at: "2026-11-08T00:00:00.000Z", reason: "Corrective assignment sent for recording" } };
  const waived = assignments(notes, collateral, { waivers });
  assert.equal(waived.line.state, "waived");
  // Every other item on these two loans is still missing, so only this line is asserted.
  assert.equal(waived.line.missing.length, 0);
  assert.equal(waived.line.waived[0].waiver.reason, "Corrective assignment sent for recording");
});

test("a loan MERS holds needs no recorded assignment; an eNote still does", () => {
  // A MOM loan: the desk checked the MIN against the mortgage and nothing is recorded, so the item isn't asked.
  const mom = assignments([loan("a", { mersMin: MIN, verifiedFields: checkedMin() })], []);
  assert.equal(mom.line.required, 0);
  assert.equal(mom.line.state, "not_required");
  // A MIN the seller typed, unchecked, proves nothing about who holds the lien.
  assert.equal(assignments([loan("a", { mersMin: MIN })], []).line.state, "missing");
  // A MIN changed since the desk checked it reads as unchecked.
  assert.equal(assignments([loan("a", { mersMin: "100123400000000025", verifiedFields: checkedMin() })], []).line.state, "missing");
  // Once a link is recorded on a MOM loan the chain is read: an assignment out of MERS must reach the seller.
  assert.equal(assignments([loan("a", { mersMin: MIN, verifiedFields: checkedMin() })], [assignment("a", 1, "MERS as nominee for First Bank", "Other Fund")]).line.state, "missing");
  assert.equal(assignments([loan("a", { mersMin: MIN, verifiedFields: checkedMin() })], [assignment("a", 1, "Mortgage Electronic Registration Systems, Inc., as nominee for First Bank", SELLER)]).line.state, "complete");
  // A loan assigned into MERS after origination: the recorded chain ends with MERS, which isn't a break.
  assert.equal(assignments([loan("a")], [assignment("a", 1, "First Bank", "Mortgage Electronic Registration Systems, Inc.")]).line.state, "complete");

  // An eNote has no endorsements, but its mortgage still moves by recorded assignment.
  const eNote = diligenceChecklist({ kind: "SINGLE", notes: [loan("e", { eNote: true })], collateral: [], documents: [], holder: SELLER, release: false });
  assert.equal(eNote.lines.find((row) => row.key === "ENDORSEMENTS")!.state, "not_required");
  assert.equal(eNote.lines.find((row) => row.key === "ASSIGNMENTS")!.state, "missing");
  const eNoteMom = diligenceChecklist({ kind: "SINGLE", notes: [loan("e", { eNote: true, mersMin: MIN, verifiedFields: checkedMin() })], collateral: [], documents: [], holder: SELLER, release: false });
  assert.equal(eNoteMom.lines.find((row) => row.key === "ASSIGNMENTS")!.state, "not_required");
});

test("the chain panel reads MERS as one party and a chain ending with it as a caution, not a break", () => {
  assert.equal(isMers("MERS, Inc. as nominee for First Bank"), true);
  assert.equal(isMers("Mortgage Electronic Registration Systems, Inc."), true);
  assert.equal(isMers("Merson Capital"), false);
  const row = (id: string, sequence: number, from: string, to: string, kind = "ASSIGNMENT") => ({ id, kind, status: "PRESENT", sequence, detail: `${from} → ${to}` });
  const intoMers = chainOfTitle([row("a1", 1, "First Bank", "Mortgage Electronic Registration Systems, Inc.")], SELLER);
  assert.deepEqual(intoMers.assignments.breaks, []);
  assert.match(intoMers.assignments.cautions[0], /end with MERS as nominee/);
  // MERS in another spelling on the next link is no gap.
  const outOfMers = chainOfTitle([row("a1", 1, "First Bank", "MERS"), row("a2", 2, "Mortgage Electronic Registration Systems, Inc. as nominee for First Bank", SELLER)], SELLER);
  assert.deepEqual(outOfMers.assignments.breaks, []);
  // The note endorsed to the seller and the mortgage held by MERS isn't the split the mortgage-follows-the-note caution means.
  const split = chainOfTitle([row("e1", 1, "First Bank", SELLER, "ALLONGE"), row("a1", 1, "First Bank", "MERS")], SELLER);
  assert.deepEqual(split.cautions, []);
  // An assignment chain ending with anyone else still breaks.
  assert.match(chainOfTitle([row("a1", 1, "First Bank", "Other Fund")], SELLER).assignments.breaks[0].message, /ends with Other Fund/);
});

// ---------------------------------------------------------------------------------------------------------------
// E4: the MIN and borrower keys, and the approval hold

test("the MIN and the borrower name with the ZIP are keys, in any spelling", () => {
  const a = duplicateKeys({ streetAddress: "1 A St", city: "Tampa", state: "FL", zip: "33602", upb: 1, mersMin: "1001234-0000000001-7", borrowerName: "SMITH, JOHN A." });
  const b = duplicateKeys({ streetAddress: "9 Z Rd", city: "Miami", state: "FL", zip: "33602-1234", upb: 2, mersMin: "100123400000000017", borrowerName: "Mr. John Smith" });
  assert.equal(a.min, "100123400000000017");
  assert.equal(a.min, b.min);
  assert.equal(a.borrowerZip, b.borrowerZip);
  assert.notEqual(a.borrowerZip, null);
  // A MIN isn't 17 digits or a run of zeros.
  assert.equal(duplicateKeys({ streetAddress: "", city: "", state: "", upb: 0, mersMin: "10012340000000001" }).min, null);
  assert.equal(duplicateKeys({ streetAddress: "", city: "", state: "", upb: 0, mersMin: "000000000000000000" }).min, null);
  // A name needs the ZIP, two words, and something other than a placeholder.
  assert.equal(duplicateKeys({ streetAddress: "", city: "Tampa", state: "FL", upb: 0, borrowerName: "John Smith" }).borrowerZip, null);
  assert.equal(duplicateKeys({ streetAddress: "", city: "", state: "", zip: "33602", upb: 0, borrowerName: "Smith" }).borrowerZip, null);
  assert.equal(duplicateKeys({ streetAddress: "", city: "", state: "", zip: "33602", upb: 0, borrowerName: "Name withheld" }).borrowerZip, null);
  assert.equal(duplicateKeys({ streetAddress: "", city: "", state: "", zip: "33602", upb: 0, borrowerName: "Unknown Borrower" }).borrowerZip, null);
  assert.equal(duplicateKeys({ streetAddress: "", city: "", state: "", zip: "33602", upb: 0, borrowerName: "Coastal Rentals, L.L.C." }).borrowerZip, duplicateKeys({ streetAddress: "", city: "", state: "", zip: "33602", upb: 0, borrowerName: "COASTAL RENTALS LLC" }).borrowerZip);
  assert.equal(duplicateGateMessage(1, null), DUPLICATE_HOLD);
  assert.equal(duplicateGateMessage(1, new Date()), null);
  assert.equal(duplicateGateMessage(0, null), null);
});

test("a MIN or borrower match holds approval until the sales desk clears it, and a changed loan asks again", async () => {
  const tag = `${Date.now()}${crypto.randomUUID().slice(0, 6)}`;
  const zip = String(10000 + (Date.now() % 89999)).padStart(5, "0");
  const otherZip = String(10000 + ((Date.now() + 7) % 89999)).padStart(5, "0");
  const min = `9${String(Date.now()).slice(-11)}${String(Math.floor(Math.random() * 1e6)).padStart(6, "0")}`;
  const users: { id: string; email: string }[] = [];
  const person = async (prefix: string, role: Role, extra: Record<string, unknown> = {}) => {
    const user = await prisma.user.create({
      data: { email: `e-dupe-${prefix}-${tag}@example.org`, name: `${prefix} ${tag}`, companyName: role === "ADMIN" ? "" : `${prefix} Notes ${tag}`, role, accountStatus: "APPROVED", passwordHash: "x", ...extra },
    });
    users.push(user);
    return user;
  };
  const ids: string[] = [];
  const note = (street: string, extra: Record<string, unknown> = {}) => ({
    streetAddress: street,
    city: `Dupeville ${tag}`,
    state: "FL",
    zip,
    propertyType: "SFR" as const,
    lienPosition: "FIRST" as const,
    upb: 100000,
    interestRate: 6,
    monthlyPi: 600,
    paymentStatus: "PERFORMING" as const,
    estimatedValue: 150000,
    askingPrice: 80000,
    ...extra,
  });
  try {
    const first = await person("first", "INSTITUTIONAL_SELLER");
    const second = await person("second", "INSTITUTIONAL_SELLER");
    const sales = await person("sales", "ADMIN", { deskRole: "SALES" });
    const compliance = await person("compliance", "ADMIN", { deskRole: "COMPLIANCE" });
    const live = await prisma.listing.create({
      data: {
        kind: "POOL",
        sellerId: first.id,
        status: "APPROVED",
        title: `Live ${tag}`,
        notes: {
          create: [
            note(`1 ${tag} Elm St`, { city: `Elmton ${tag}`, zip: "00011", mersMin: min }),
            note(`2 ${tag} Oak St`, { borrowerName: `Riley J. Brooks Q${tag}` }),
            note(`3 ${tag} Ash St`, { borrowerName: "Unknown Borrower" }),
          ],
        },
      },
    });
    ids.push(live.id);
    const fresh = await prisma.listing.create({
      data: {
        kind: "POOL",
        sellerId: second.id,
        status: "SUBMITTED",
        title: `Fresh ${tag}`,
        notes: {
          create: [
            // Nothing else alike: another street, city and ZIP. Only the MIN, typed with dashes, ties it to the live loan.
            note(`71 ${tag} Far Rd`, { city: `Farton ${tag}`, zip: "00012", mersMin: `${min.slice(0, 7)}-${min.slice(7, 17)}-${min.slice(17)}` }),
            // The same borrower, written last name first, in the same ZIP on another street.
            note(`72 ${tag} Pine St`, { city: `Pineton ${tag}`, borrowerName: `Q${tag.toUpperCase()}, BROOKS, RILEY` }),
            // The same borrower in another ZIP and city: a name alone doesn't match.
            note(`73 ${tag} Fir St`, { city: `Firton ${tag}`, zip: otherZip, borrowerName: `Riley Brooks Q${tag}` }),
            // A placeholder name in the same ZIP doesn't match either.
            note(`74 ${tag} Yew St`, { city: `Yewton ${tag}`, borrowerName: "Unknown Borrower" }),
          ],
        },
      },
      include: { notes: true },
    });
    ids.push(fresh.id);
    const byStreet = new Map(fresh.notes.map((row) => [row.id, row.streetAddress.split(" ")[0]]));
    const matches = (await duplicatesFor(fresh.id)).filter((match) => ids.includes(match.listing.id));
    assert.deepEqual(matches.map((match) => `${byStreet.get(match.noteId)}:${match.reason}`).sort(), ["71:MIN", "72:BORROWER_ZIP"]);

    // The seller filed as before. Approval holds until the desk clears the match.
    assert.equal(await duplicateHold(fresh.id), DUPLICATE_HOLD);
    assert.deepEqual(await clearDuplicates(compliance, { listingId: fresh.id, note: "Compared the MINs" }), { ok: false, error: DESK_DENIED });
    assert.deepEqual(await clearDuplicates(sales, { listingId: fresh.id, note: "ok" }), { ok: false, error: "Say what the desk compared and why both loans may stand." });
    const at = new Date("2026-11-09T10:00:00.000Z");
    const cleared = await clearDuplicates(sales, { listingId: fresh.id, note: "MERS shows the second seller as investor since October; the live tape is stale.", now: at });
    assert.deepEqual(cleared, { ok: true, value: { matches: 2 } });
    const stored = await prisma.listing.findUniqueOrThrow({ where: { id: fresh.id } });
    assert.equal(stored.duplicateClearedAt?.toISOString(), at.toISOString());
    assert.equal(stored.duplicateClearedById, sales.id);
    assert.match(stored.duplicateClearNote ?? "", /^MERS shows the second seller/);
    const event = await prisma.auditEvent.findFirst({ where: { action: "DUPLICATE_CLEARED", entityId: fresh.id, actorId: sales.id } });
    assert.ok(event?.detail.includes(live.id));
    assert.match(event?.detail ?? "", /same MERS MIN; same borrower name and ZIP/);
    assert.equal(await duplicateHold(fresh.id), null);
    assert.deepEqual(await clearDuplicates(sales, { listingId: fresh.id, note: "Again" }), { ok: false, error: "The match is already cleared." });

    // What identifies a loan changed, so the check runs again: the clearance is lifted and the seller reads that
    // approval waits, with no other listing or seller named.
    await prisma.note.update({ where: { id: fresh.notes[1].id }, data: { upb: 100500 } });
    const again = (await flagDuplicates(fresh.id, second.id)).filter((match) => ids.includes(match.listing.id));
    assert.equal(again.length, 2);
    const lifted = await prisma.listing.findUniqueOrThrow({ where: { id: fresh.id } });
    assert.equal(lifted.duplicateClearedAt, null);
    assert.equal(lifted.duplicateClearNote, null);
    assert.ok(await prisma.auditEvent.findFirst({ where: { action: "DUPLICATE_CLEARANCE_LIFTED", entityId: fresh.id } }));
    assert.equal(await duplicateHold(fresh.id), DUPLICATE_HOLD);
    const comment = await prisma.reviewComment.findFirst({ where: { listingId: fresh.id, comment: { startsWith: DUPLICATE_COMMENT } }, orderBy: { createdAt: "desc" } });
    assert.match(comment?.comment ?? "", /Approval waits until the desk compares them\./);
    assert.ok(!comment?.comment.includes(live.title) && !comment?.comment.includes(first.name) && !comment?.comment.includes(live.id));
    const mail = await prisma.notification.findFirst({ where: { toEmail: sales.email, subject: { startsWith: DUPLICATE_COMMENT } }, orderBy: { createdAt: "desc" } });
    assert.match(mail?.body ?? "", /The seller could still submit, since a relist of the same loan can be legitimate\. Approval waits until the desk compares the loans/);
    assert.match(mail?.body ?? "", /The earlier clearance is lifted/);

    // Clearing again lets approval through; once approved, a match isn't cleared any more.
    assert.equal((await clearDuplicates(sales, { listingId: fresh.id, note: "Compared again after the UPB change." })).ok, true);
    assert.equal(await duplicateHold(fresh.id), null);
    await prisma.listing.update({ where: { id: live.id }, data: { status: "WITHDRAWN" } });
    await prisma.listing.update({ where: { id: fresh.id }, data: { status: "APPROVED", duplicateClearedAt: null } });
    assert.deepEqual(await clearDuplicates(sales, { listingId: fresh.id, note: "Late clearance" }), { ok: false, error: "A match is cleared before the listing is approved." });
  } finally {
    const userIds = users.map((user) => user.id);
    await prisma.reviewComment.deleteMany({ where: { listingId: { in: ids } } });
    await prisma.auditEvent.deleteMany({ where: { OR: [{ entityId: { in: ids } }, { actorId: { in: userIds } }] } });
    await prisma.notification.deleteMany({ where: { OR: [{ toEmail: { in: users.map((user) => user.email) } }, { subject: { contains: tag } }] } });
    await prisma.note.deleteMany({ where: { listingId: { in: ids } } });
    await prisma.listing.deleteMany({ where: { id: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
});

test("the desk's approval checks the duplicate hold after the diligence set and before it moves the status", async () => {
  const source = await fs.readFile(path.join(process.cwd(), "actions/admin.ts"), "utf8");
  const approve = source.slice(source.indexOf('if (action === "APPROVE")'), source.indexOf('if (action === "REJECT")'));
  const at = (needle: string) => approve.indexOf(needle);
  assert.ok(at("duplicateHold(") > 0);
  assert.ok(at("diligenceHold(") < at("duplicateHold(") && at("duplicateHold(") < at('status: "APPROVED"'));
  // The clearance is the sales side's, checked in the action as well as in lib/duplicates.ts.
  assert.match(await fs.readFile(path.join(process.cwd(), "actions/duplicates.ts"), "utf8"), /requireDesk\("sales"/);
});
