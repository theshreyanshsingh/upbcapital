"use server";

import bcrypt from "bcryptjs";
import { createHash, randomBytes } from "node:crypto";
import { redirect } from "next/navigation";
import { accountLocked } from "@/lib/access";
import { audit } from "@/lib/audit";
import { endSessions } from "@/lib/auth";
import { notify, sendSecret } from "@/lib/email";
import { prisma } from "@/lib/prisma";
import { consumeRateLimit } from "@/lib/rate-limit";
import { requestMeta } from "@/lib/request-meta";

const RESET_MS = 60 * 60 * 1000;

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

// The answer is the same whether or not the address has an account. Only the hash of the token is stored.
export async function requestPasswordReset(formData: FormData) {
  const email = String(formData.get("email") || "").trim().toLowerCase();
  const meta = await requestMeta();
  const allowed = (await consumeRateLimit(`reset-ip:${meta.ipAddress}`, 10, RESET_MS)) && (await consumeRateLimit(`reset:${email}`, 3, RESET_MS));
  if (allowed && email) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user && !accountLocked(user.accountStatus)) {
      const token = randomBytes(32).toString("hex");
      await prisma.passwordReset.deleteMany({ where: { userId: user.id } });
      await prisma.passwordReset.create({
        data: { userId: user.id, tokenHash: tokenHash(token), expiresAt: new Date(Date.now() + RESET_MS) },
      });
      await audit(user.id, "PASSWORD_RESET_REQUESTED", "user", user.id, meta.ipAddress);
      const link = `${process.env.NEXT_PUBLIC_APP_URL || ""}/login/reset?token=${token}`;
      await sendSecret(user.email, "Reset your UPB Capital password", `Open this link within an hour to choose a new password:\n\n${link}\n\nIf you did not ask for this, ignore it. Your password has not changed.`);
    }
  }
  redirect("/login/forgot?notice=reset_sent");
}

export async function resetPassword(formData: FormData) {
  const token = String(formData.get("token") || "");
  const password = String(formData.get("password") || "");
  const again = `/login/reset?token=${encodeURIComponent(token)}`;
  if (password.length < 8) redirect(`${again}&error=${encodeURIComponent("Use at least 8 characters.")}`);
  if (password !== String(formData.get("confirm") || "")) redirect(`${again}&error=${encodeURIComponent("Those passwords do not match.")}`);
  const row = await prisma.passwordReset.findUnique({ where: { tokenHash: tokenHash(token) } });
  const user = row && row.expiresAt.getTime() > Date.now() ? await prisma.user.findUnique({ where: { id: row.userId } }) : null;
  if (!user || accountLocked(user.accountStatus)) {
    redirect(`/login/forgot?error=${encodeURIComponent("That link has expired or was already used. Ask for a new one.")}`);
  }
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await bcrypt.hash(password, 10) } });
  await prisma.passwordReset.deleteMany({ where: { userId: user.id } });
  await endSessions(user.id);
  const meta = await requestMeta();
  await audit(user.id, "PASSWORD_RESET", "user", user.id, meta.ipAddress);
  await notify(user.email, "Your UPB Capital password changed", "Your password was just reset, and every device was signed out. If this was not you, write the desk now.");
  redirect("/login?notice=password_reset");
}
