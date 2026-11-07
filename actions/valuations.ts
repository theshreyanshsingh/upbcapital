"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { requestMeta } from "@/lib/request-meta";
import { requireDesk } from "@/lib/staff";
import { MAX_TYPED_LOANS, closeValuation, inviteFromValuation, linkValuationListing, quoteValuation, requestValuation, type TypedLoan } from "@/lib/valuations";

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
