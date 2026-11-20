"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireDesk } from "@/lib/staff";
import { saveSecurityPack } from "@/lib/vendor-pack";

function back(message: string, kind: "notice" | "error"): never {
  redirect(`/admin/compliance?${kind}=${encodeURIComponent(message)}#vendor-pack`);
}

// The facts the vendor pack can't read from the code: the last penetration test, the cyber insurer, the recovery
// targets and the incident contact. Checked and audited in lib/vendor-pack.ts.
export async function saveVendorPackFacts(formData: FormData) {
  const actor = await requireDesk("compliance", "/admin/compliance");
  const result = await saveSecurityPack(actor, Object.fromEntries(formData));
  if (result.error !== null) back(result.error, "error");
  revalidatePath("/admin/compliance");
  revalidatePath("/security");
  back(result.changed ? "The vendor pack facts are saved. The next download carries them." : "Nothing changed.", "notice");
}
