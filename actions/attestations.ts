"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { saveAttestation } from "@/lib/track-record";

// One side's yes-or-no answers after a confirmed close. lib/track-record.ts decides which side the account answers for.
export async function saveCloseAttestation(formData: FormData) {
  const user = await requireUser();
  const closingId = String(formData.get("closingId") || "");
  const result = await saveAttestation(user, {
    closingId,
    answers: {
      fileAsDescribed: formData.get("fileAsDescribed"),
      collateralComplete: formData.get("collateralComplete"),
      fundedOnTime: formData.get("fundedOnTime"),
    },
    note: formData.get("note"),
  });
  const back = `/closings/${closingId}`;
  if (result.error !== null) redirect(`${back}?error=${encodeURIComponent(result.error)}#after-closing`);
  revalidatePath(back);
  redirect(`${back}?notice=${encodeURIComponent(result.created ? "Your answers are saved." : "Your answers are updated.")}#after-closing`);
}
