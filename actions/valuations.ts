"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { actionGate } from "@/lib/action-gates";
import { getCurrentUser, requireRole } from "@/lib/auth";
import { secureCookies } from "@/lib/deploy";
import { INTAKE_COOKIE, intakeCookieValue, isSplitRule, parseBands, planProblem, readIntakeCookie } from "@/lib/desk-intake";
import { typedNumber } from "@/lib/money";
import { requestMeta } from "@/lib/request-meta";
import { requireDesk } from "@/lib/staff";
import { deleteTapeDraft, readTapeDraft } from "@/lib/tape-draft";
import {
  MAX_TYPED_LOANS,
  askDeskToFile,
  closeValuation,
  inviteFromValuation,
  linkValuationListing,
  quoteValuation,
  requestValuation,
  stageValuationIntake,
  type TypedLoan,
} from "@/lib/valuations";

function text(formData: FormData, key: string) {
  return String(formData.get(key) ?? "");
}

// The public form: a tape or up to ten typed loans, and who is asking. The range shows on the next page.
export async function submitValuation(formData: FormData) {
  const [meta, user] = await Promise.all([requestMeta(), getCurrentUser().catch(() => null)]);
  const file = formData.get("tape");
  const tape = file instanceof File && file.size > 0 ? { name: file.name, bytes: Buffer.from(await file.arrayBuffer()) } : null;
  const column = (key: keyof TypedLoan) => formData.getAll(key).map(String);
  const states = column("state");
  const typed: TypedLoan[] = Array.from({ length: Math.min(MAX_TYPED_LOANS + 1, states.length) }, (_, index) => ({
    state: states[index],
    lienPosition: column("lienPosition")[index],
    paymentStatus: column("paymentStatus")[index],
    upb: column("upb")[index],
    interestRate: column("interestRate")[index],
    monthlyPi: column("monthlyPi")[index],
    estimatedValue: column("estimatedValue")[index],
    monthsDelinquent: column("monthsDelinquent")[index],
  }));
  const result = await requestValuation({
    name: text(formData, "name"),
    email: text(formData, "email"),
    company: text(formData, "company"),
    phone: text(formData, "phone"),
    terms: formData.get("terms"),
    typed,
    tape,
    ipAddress: meta.ipAddress,
    userId: user?.id ?? null,
  });
  if (result.error !== null) redirect(`/sell/value?error=${encodeURIComponent(result.error)}`);
  revalidatePath("/admin/valuations");
  redirect(`/sell/value/${result.id}`);
}

function deskBack(id: string, kind: "notice" | "error", message: string): never {
  revalidatePath("/admin/valuations");
  revalidatePath(`/admin/valuations/${id}`);
  redirect(`/admin/valuations/${id}?${kind}=${encodeURIComponent(message)}`);
}

export async function sendValuationQuote(formData: FormData) {
  const id = text(formData, "id");
  const actor = await requireDesk("sales", `/admin/valuations/${id}`);
  const result = await quoteValuation({ id, low: formData.get("low"), high: formData.get("high"), note: text(formData, "note"), actor });
  if (result.error !== null) deskBack(id, "error", result.error);
  deskBack(id, "notice", "The range is sent to the seller.");
}

export async function inviteValuationSeller(formData: FormData) {
  const id = text(formData, "id");
  const actor = await requireDesk("sales", `/admin/valuations/${id}`);
  const result = await inviteFromValuation({ id, role: text(formData, "role"), actor });
  if (result.error !== null) deskBack(id, "error", result.error);
  deskBack(id, "notice", result.invited ? "The account invite is sent. It lasts seven days." : "They already have a seller account, so they were asked to sign in and list.");
}

export async function linkValuation(formData: FormData) {
  const id = text(formData, "id");
  const actor = await requireDesk("sales", `/admin/valuations/${id}`);
  const result = await linkValuationListing({ id, listingId: text(formData, "listingId"), actor });
  if (result.error !== null) deskBack(id, "error", result.error);
  deskBack(id, "notice", "The request is marked listed.");
}

export async function closeValuationRequest(formData: FormData) {
  const id = text(formData, "id");
  const actor = await requireDesk("sales", `/admin/valuations/${id}`);
  const result = await closeValuation({ id, note: text(formData, "note"), actor });
  if (result.error !== null) deskBack(id, "error", result.error);
  deskBack(id, "notice", "The request is closed.");
}

// The seller's desk: "Ask the desk to file it". The desk hears and opens the tape in intake from the request.
export async function askDeskToFileValuation(formData: FormData) {
  const user = await requireRole(["INDIVIDUAL_SELLER", "INSTITUTIONAL_SELLER"]);
  const back = (kind: "notice" | "error", message: string): never => redirect(`/seller?${kind}=${encodeURIComponent(message)}#valuation`);
  const gate = await actionGate(user, "list");
  if (gate) back("error", gate);
  const result = await askDeskToFile(user, text(formData, "id"));
  if (result.error !== null) back("error", result.error);
  revalidatePath("/seller");
  back("notice", result.already ? "The desk already has this tape to file." : "The desk has your tape and will file it in your name. You confirm each listing before buyers see it.");
}

// The desk opens a request's tape in desk intake, with the price and split chosen here, and lands on the preview.
// The same cookie, path and life as a tape the desk uploads there (actions/desk-intake.ts).
export async function openValuationInIntake(formData: FormData) {
  const id = text(formData, "id");
  const actor = await requireDesk("sales", `/admin/valuations/${id}`);
  const priceMode = text(formData, "priceMode") === "PERCENT" ? "PERCENT" : "COLUMN";
  const percent = priceMode === "PERCENT" ? typedNumber(formData.get("percent")) : null;
  const rules = formData.getAll("rule").map(String).filter(isSplitRule);
  const bands = rules.includes("BALANCE") ? parseBands(text(formData, "bands")) : [];
  if (bands === null) deskBack(id, "error", "Write the balance edges as amounts, such as 100k, 250k. Up to six.");
  const plan = planProblem({ rules, bands });
  if (plan) deskBack(id, "error", plan);
  const result = await stageValuationIntake(actor, { id, priceMode, percent: percent != null && Number.isFinite(percent) ? percent : null, rules, bands });
  if (result.error !== null) deskBack(id, "error", result.error);
  const jar = await cookies();
  // One staged tape at a time: this one replaces whatever the intake page had.
  const earlier = readIntakeCookie(jar.get(INTAKE_COOKIE)?.value);
  if (earlier && (await readTapeDraft(actor.id, earlier.token))) await deleteTapeDraft(earlier.token);
  jar.set(INTAKE_COOKIE, intakeCookieValue(result.staged), { httpOnly: true, sameSite: "lax", secure: secureCookies(), path: "/admin/intake", maxAge: 24 * 60 * 60 });
  redirect("/admin/intake#preview");
}
