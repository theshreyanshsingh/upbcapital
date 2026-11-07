"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { acceptMaster, agreementBack, masterLabel } from "@/lib/agreements";
import { requireUser } from "@/lib/auth";
import { requestMeta } from "@/lib/request-meta";

// A member signs their own master agreement, for their own account only. lib/agreements.ts checks the agreement is
// one their role signs.
export async function signMasterAgreement(formData: FormData) {
  const user = await requireUser();
  const back = agreementBack(formData.get("back"));
  const page = back ? `/account/agreements?back=${encodeURIComponent(back)}&` : "/account/agreements?";
  const meta = await requestMeta();
  const result = await acceptMaster(user, {
    kind: formData.get("kind"),
    signerName: formData.get("signerName"),
    signerTitle: formData.get("signerTitle"),
    entityName: formData.get("entityName"),
    agreed: formData.get("agreed"),
    ip: meta.ipAddress,
    userAgent: meta.userAgent,
  });
  if (result.error !== null) redirect(`${page}error=${encodeURIComponent(result.error)}`);
  revalidatePath("/account/agreements");
  revalidatePath("/buyer/offers");
  revalidatePath("/seller");
  if (back) revalidatePath(back);
  const label = masterLabel(result.kind);
  const notice = result.already
    ? `You had already signed version ${result.acceptance.version} of the ${label}.`
    : `Version ${result.acceptance.version} of the ${label} is signed.`;
  redirect(`${back ?? "/account/agreements"}?notice=${encodeURIComponent(notice)}`);
}
