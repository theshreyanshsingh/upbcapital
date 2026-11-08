"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { actionGate } from "@/lib/action-gates";
import { requireRole, requireUser } from "@/lib/auth";
import {
  acceptTerms,
  addTranche,
  closeOwnProgram,
  createProgram,
  criteriaFlags,
  criteriaOf,
  decideProgram,
  flagLine,
  inviteToProgram,
  moveCommitment,
  readGrid,
  removeTranche,
  setGrid,
  tapeProgram,
  updateProgram,
  type ProgramInput,
} from "@/lib/flow-programs";
import { typedNumber } from "@/lib/money";
import { DESK_DENIED, deskCan, requireDesk } from "@/lib/staff";
import type { TapeFieldKey } from "@/lib/tape-fields";

// Forward-flow programmes: the seller's programme and tranches, the desk's decisions, and the buyer's terms, grid and
// place. Each action checks who is asking, and lib/flow-programs.ts checks them against the programme.

type Result = { ok: true } | { ok: false; error: string };

function back(path: string, outcome: Result, notice: string, hash = ""): never {
  revalidatePath(path);
  revalidatePath("/admin/flow");
  revalidatePath("/buyer/flow");
  redirect(`${path}?${outcome.ok ? `notice=${encodeURIComponent(notice)}` : `error=${encodeURIComponent(outcome.error)}`}${hash}`);
}

const id = (formData: FormData, key: string) => String(formData.get(key) || "");

function programInput(formData: FormData): ProgramInput {
  return {
    name: formData.get("name"),
    cadence: formData.get("cadence"),
    firstLookHours: formData.get("firstLookHours"),
    expectedVolume: formData.get("expectedVolume"),
    terms: formData.get("terms"),
    lienPositions: formData.getAll("lienPositions").map(String),
    paymentStatuses: formData.getAll("paymentStatuses").map(String),
    states: formData.get("states"),
    maxUpb: formData.get("maxUpb"),
    minSeasoningMonths: formData.get("minSeasoningMonths"),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The seller.

async function seller() {
  return requireRole(["INSTITUTIONAL_SELLER"]);
}

// The programme form answers in place, so a long terms text survives a mistake. A new programme goes to the desk.
export async function saveFlowProgram(formData: FormData): Promise<{ error: string }> {
  const user = await seller();
  if (user.accountStatus !== "APPROVED") return { error: "Your institutional account is still in review." };
  const gate = await actionGate(user, "list");
  if (gate) return { error: gate };
  const programId = id(formData, "programId");
  const outcome = programId ? await updateProgram(user, programId, programInput(formData)) : await createProgram(user, programInput(formData));
  if (!outcome.ok) return { error: outcome.error };
  revalidatePath("/seller/flow");
  revalidatePath("/admin/flow");
  revalidatePath(`/seller/flow/${outcome.value.id}`);
  const notice = programId ? "Saved. The desk reads the programme as it stands now." : "Sent to the desk. Once it is approved you can invite buyers and add tranches.";
  redirect(`/seller/flow/${outcome.value.id}?notice=${encodeURIComponent(notice)}`);
}

export async function closeFlowProgram(formData: FormData) {
  const user = await seller();
  const programId = id(formData, "programId");
  back(`/seller/flow/${programId}`, await closeOwnProgram(user, programId), "Closed. Tranches still in first look are open to the market now.");
}

export async function addFlowTranche(formData: FormData) {
  const user = await seller();
  const programId = id(formData, "programId");
  const gate = await actionGate(user, "list");
  const outcome = gate ? ({ ok: false, error: gate } as const) : await addTranche(user, { programId, listingId: id(formData, "listingId") });
  const notice = outcome.ok
    ? `Tranche ${outcome.value.sequence} is with the desk for review.${outcome.value.flagged ? ` ${outcome.value.flagged} loan${outcome.value.flagged === 1 ? " sits" : "s sit"} outside the criteria, and the desk sees that too.` : ""}`
    : "";
  revalidatePath("/seller");
  back(`/seller/flow/${programId}`, outcome, notice, "#tranches");
}

export async function removeFlowTranche(formData: FormData) {
  const user = await seller();
  const programId = id(formData, "programId");
  back(`/seller/flow/${programId}`, await removeTranche(user, id(formData, "trancheId")), "Taken out of the programme. It stays with the desk as an ordinary listing.", "#tranches");
}

// The seller from their programme page, or the desk from its own.
export async function inviteFlowBuyers(formData: FormData) {
  const user = await requireUser();
  const programId = id(formData, "programId");
  const desk = user.role === "ADMIN";
  const page = desk ? `/admin/flow/${programId}` : `/seller/flow/${programId}`;
  const outcome =
    desk && !deskCan(user, "sales")
      ? ({ ok: false, error: DESK_DENIED } as const)
      : !desk && user.role !== "INSTITUTIONAL_SELLER"
        ? ({ ok: false, error: "Only the programme's seller or the desk invites buyers." } as const)
        : await inviteToProgram(user, { programId, emails: formData.get("emails") });
  let notice = "";
  if (outcome.ok) {
    const { invited, skipped } = outcome.value;
    const sent = invited.length ? `Invited ${invited.length} buyer${invited.length === 1 ? "" : "s"}.` : "No new invitations went out.";
    const passed = skipped.map((row) => `${row.email} (${row.reason})`).join(", ");
    notice = passed ? `${sent} Skipped ${passed}.` : sent;
  }
  back(page, outcome, notice, "#buyers");
}

export type TapeCheck = { programId: string; token: string; mapping: Partial<Record<TapeFieldKey, string>>; priceMode: string; pricePercent: string; poolTotal: string };

// The tape wizard's confirm step, for a tape uploaded into a programme: which loans sit outside its criteria.
export async function checkFlowTape(input: TapeCheck): Promise<{ error: string | null; loans: number; flagged: number; lines: string[] }> {
  const none = { loans: 0, flagged: 0, lines: [] };
  const user = await requireUser();
  if (user.role !== "INSTITUTIONAL_SELLER") return { error: "Tape uploads into a programme are for its seller.", ...none };
  const { consumeRateLimit } = await import("@/lib/rate-limit");
  if (!(await consumeRateLimit(`flow-check:${user.id}`, 30, 10 * 60 * 1000))) return { error: "That is a lot of checks in a few minutes. Try again shortly.", ...none };
  const program = await tapeProgram(user.id, String(input?.programId ?? ""));
  if (!program) return { error: "That programme isn't taking tranches.", ...none };
  const token = String(input?.token ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(token)) return { error: "Upload the tape again.", ...none };
  const priceMode = input?.priceMode === "PERCENT" || input?.priceMode === "POOL_TOTAL" ? input.priceMode : "COLUMN";
  const mapping = Object.fromEntries(
    Object.entries(input?.mapping && typeof input.mapping === "object" ? input.mapping : {}).filter(([, header]) => typeof header === "string"),
  ) as Partial<Record<TapeFieldKey, string>>;
  const [{ readTapeDraft }, { normalizeTapeRows, parseTapeBuffer }] = await Promise.all([import("@/lib/tape-draft"), import("@/lib/tape")]);
  const draft = await readTapeDraft(user.id, token);
  if (!draft) return { error: "That tape expired. Upload it again.", ...none };
  const { loans, errors } = normalizeTapeRows({
    rows: parseTapeBuffer(draft.bytes, draft.filename).rows,
    mapping,
    priceMode,
    pricePercent: typedNumber(input?.pricePercent),
    poolTotal: typedNumber(input?.poolTotal),
  });
  if (errors.length) return { error: "Fix the tape's errors to check it against the programme.", ...none };
  const flags = criteriaFlags(loans, criteriaOf(program.criteria));
  return { error: null, loans: loans.length, flagged: flags.length, lines: flags.slice(0, 20).map(flagLine) };
}

// ---------------------------------------------------------------------------------------------------------------
// The desk.

export async function decideFlowProgram(formData: FormData) {
  const programId = id(formData, "programId");
  const user = await requireDesk("sales", `/admin/flow/${programId}`);
  const decision = id(formData, "decision");
  const outcome = await decideProgram(user, { programId, decision, note: formData.get("note") });
  const said: Record<string, string> = {
    APPROVE: "Approved. The seller can invite buyers and add tranches.",
    PAUSE: "Paused. It takes no new tranches until it is resumed.",
    RESUME: "Resumed. It takes tranches again.",
    CLOSE: "Closed. Tranches still in first look are open to the market now.",
  };
  revalidatePath(`/seller/flow/${programId}`);
  back(`/admin/flow/${programId}`, outcome, said[decision] ?? "Saved.");
}

// ---------------------------------------------------------------------------------------------------------------
// The buyer.

async function buyer() {
  return requireRole(["BUYER"]);
}

export async function acceptFlowTerms(formData: FormData) {
  const user = await buyer();
  const commitmentId = id(formData, "commitmentId");
  const gate = await actionGate(user, "sign");
  const outcome = gate
    ? ({ ok: false, error: gate } as const)
    : formData.get("accept") !== "yes"
      ? ({ ok: false, error: "Tick the box to say you read and accept the terms." } as const)
      : await acceptTerms(user, { commitmentId, version: formData.get("version") });
  back("/buyer/flow", outcome, "You are in. Set your price grid so each tranche's bid form comes pre-filled.", `#program-${commitmentId}`);
}

// The grid form answers in place, so the rows typed survive a mistake.
export async function saveFlowGrid(formData: FormData): Promise<{ error: string }> {
  const user = await buyer();
  const commitmentId = id(formData, "commitmentId");
  const read = readGrid({
    statuses: formData.getAll("gridStatus"),
    liens: formData.getAll("gridLien"),
    ltvs: formData.getAll("gridLtv"),
    pcts: formData.getAll("gridPct"),
  });
  if (read.error !== null) return { error: read.error };
  const outcome = await setGrid(user, { commitmentId, grid: read.grid, cap: formData.get("cap") });
  if (!outcome.ok) return { error: outcome.error };
  back("/buyer/flow", outcome, "Grid saved. It pre-fills the bid form on this programme's tranches. You still confirm every bid.", `#program-${commitmentId}`);
}

export async function moveFlowCommitment(formData: FormData) {
  const user = await buyer();
  const commitmentId = id(formData, "commitmentId");
  const move = String(formData.get("move") || "");
  const outcome = await moveCommitment(user, { commitmentId, move });
  const said: Record<string, string> = {
    DECLINE: "Declined. The programme won't send you its tranches first.",
    RESUME: "Resumed. Tranches come to you first again.",
    PAUSE: "Paused. Tranches reach you with the market until you resume.",
    LEAVE: "Done. You are out of this programme, and your open bids stand.",
  };
  back("/buyer/flow", outcome, said[move] ?? "Saved.", `#program-${commitmentId}`);
}
