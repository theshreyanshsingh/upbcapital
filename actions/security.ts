"use server";

import bcrypt from "bcryptjs";
import { createHash, randomInt } from "crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { accountLocked, needsSecondFactor } from "@/lib/access";
import { audit } from "@/lib/audit";
import { clearPending, currentSessionId, endSessions, pendingUserId, requirePerson, setSession, twoStepRequired } from "@/lib/auth";
import { demoSeat } from "@/lib/deploy";
import { sendAlert, sendSecret } from "@/lib/email";
import { homeFor } from "@/lib/labels";
import { prisma } from "@/lib/prisma";
import { consumeRateLimit } from "@/lib/rate-limit";
import { newRecoveryCodes, packHashes, takeRecoveryCode } from "@/lib/recovery";
import { safeNext } from "@/lib/safe-next";
import { secondFactorSubject } from "@/lib/seats";
import { generateTotpSecret, verifyTotp } from "@/lib/totp";
import { unset } from "@/lib/db-filters";

// Each action works on the person signed in. A firm's seat has its own password, authenticator and devices, so
// it never touches the firm's (lib/seats.ts).
export async function beginTotp() {
  const { person: user } = await requirePerson({ secondFactorSetup: true });
  if (user.totpEnabled) redirect("/account/security");
  const secret = generateTotpSecret();
  await prisma.user.update({ where: { id: user.id }, data: { totpSecret: secret, totpEnabled: false } });
  redirect("/account/security?notice=totp");
}

export async function confirmTotp(formData: FormData) {
  const { person: user } = await requirePerson({ secondFactorSetup: true });
  const code = String(formData.get("code") || "");
  if (!user.totpSecret || !verifyTotp(user.totpSecret, code)) {
    redirect("/account/security?error=" + encodeURIComponent("That code does not match the secret on this account."));
  }
  const codes = newRecoveryCodes();
  await prisma.user.update({
    where: { id: user.id },
    data: { totpEnabled: true, recoveryHashes: packHashes(codes), recoveryReveal: codes.join("\n") },
  });
  await audit(user.id, "TOTP_ON", "user", user.id);
  redirect("/account/security?notice=codes");
}

export async function acknowledgeRecovery() {
  const { person: user } = await requirePerson({ secondFactorSetup: true });
  await prisma.user.update({ where: { id: user.id }, data: { recoveryReveal: "" } });
  redirect("/account/security?notice=totp_on");
}

export async function disableTotp(formData: FormData) {
  const account = await requirePerson({ secondFactorSetup: true });
  const user = account.person;
  if (needsSecondFactor({ ...secondFactorSubject(account), totpEnabled: false }, await twoStepRequired())) {
    redirect("/account/security?error=" + encodeURIComponent("The desk requires two-step sign-in on this account, so it stays on."));
  }
  if (!(await consumeRateLimit(`totp:${user.id}`, 5, 15 * 60 * 1000))) {
    redirect("/account/security?error=" + encodeURIComponent("Too many codes. Wait fifteen minutes and try again."));
  }
  const code = String(formData.get("code") || "");
  const recovery = takeRecoveryCode(user.recoveryHashes, code);
  const ok = verifyTotp(user.totpSecret, code) || recovery != null;
  if (!user.totpEnabled || !ok) {
    redirect("/account/security?error=" + encodeURIComponent("Enter a current code or a recovery code to turn this off."));
  }
  await prisma.user.update({
    where: { id: user.id },
    data: { totpEnabled: false, totpSecret: "", recoveryHashes: "", recoveryReveal: "", emailOtpFallback: false },
  });
  await audit(user.id, "TOTP_OFF", "user", user.id);
  redirect("/account/security?notice=totp_off");
}

export async function setEmailFallback(formData: FormData) {
  const { person: user } = await requirePerson({ secondFactorSetup: true });
  if (!user.totpEnabled) redirect("/account/security");
  await prisma.user.update({ where: { id: user.id }, data: { emailOtpFallback: formData.get("enabled") === "yes" } });
  redirect("/account/security?notice=email_otp");
}

async function acceptSecondFactor(user: { id: string; totpSecret: string; recoveryHashes: string; email: string }, code: string) {
  if (verifyTotp(user.totpSecret, code)) return true;
  // Single-use codes are taken with a conditional write, so two requests racing with one code can't both pass.
  const remaining = takeRecoveryCode(user.recoveryHashes, code);
  if (remaining != null) {
    const taken = await prisma.user.updateMany({ where: { id: user.id, recoveryHashes: user.recoveryHashes }, data: { recoveryHashes: remaining } });
    return taken.count === 1;
  }
  const hash = createHash("sha256").update(code.replace(/\s/g, "")).digest("hex");
  const row = await prisma.loginCode.findFirst({
    where: { userId: user.id, codeHash: hash, ...unset("usedAt"), expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
  if (!row) return false;
  const taken = await prisma.loginCode.updateMany({ where: { id: row.id, ...unset("usedAt") }, data: { usedAt: new Date() } });
  return taken.count === 1;
}

export async function verifyLoginTotp(formData: FormData) {
  const userId = await pendingUserId();
  if (!userId) redirect("/login?error=" + encodeURIComponent("Sign in again, then enter the code."));
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !user.totpEnabled || accountLocked(user.accountStatus)) redirect("/login");
  // The page sign-in was going to, carried through the code step. Same-site paths only.
  const next = safeNext(formData.get("next"), "");
  const verify = `/login/verify?${next ? `next=${encodeURIComponent(next)}&` : ""}error=`;
  if (!(await consumeRateLimit(`totp:${user.id}`, 5, 15 * 60 * 1000))) {
    redirect(verify + encodeURIComponent("Too many codes. Wait fifteen minutes and try again."));
  }
  const code = String(formData.get("code") || "");
  if (!(await acceptSecondFactor(user, code))) {
    redirect(verify + encodeURIComponent("That code is not current."));
  }
  await clearPending();
  await setSession({ sub: user.id, email: user.email, role: user.role, name: user.name });
  await audit(user.id, "LOGIN", "user", user.id, "with second factor");
  const fallback = user.role === "BUYER" && user.accountStatus !== "APPROVED" ? "/buyer/pending" : homeFor(user.role);
  redirect(safeNext(next, fallback));
}

export async function sendEmailCode() {
  const userId = await pendingUserId();
  if (!userId) redirect("/login");
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.totpEnabled || !user.emailOtpFallback) {
    redirect("/login/verify?error=" + encodeURIComponent("Email codes are off for this account."));
  }
  if (!(await consumeRateLimit(`email-otp:${user.id}`, 3, 10 * 60 * 1000))) {
    redirect("/login/verify?error=" + encodeURIComponent("Wait a few minutes before another email code."));
  }
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const codeHash = createHash("sha256").update(code).digest("hex");
  await prisma.loginCode.create({
    data: { userId: user.id, codeHash, expiresAt: new Date(Date.now() + 10 * 60 * 1000) },
  });
  // The code ignores notice settings and never lands in the in-app inbox, which can't be read before sign-in.
  await sendSecret(user.email, "Your UPB Capital sign-in code", `Your code is ${code}. It expires in ten minutes.`);
  redirect("/login/verify?notice=email_sent");
}

export async function changePassword(formData: FormData) {
  const { person: user } = await requirePerson({ secondFactorSetup: true });
  const back = (message: string) => redirect(`/account/security?error=${encodeURIComponent(message)}`);
  if (demoSeat(user.email)) back("Demo accounts keep the shared password.");
  if (!(await consumeRateLimit(`password:${user.id}`, 5, 15 * 60 * 1000))) back("Too many tries. Wait fifteen minutes.");
  const current = String(formData.get("current") || "");
  const password = String(formData.get("password") || "");
  if (!(await bcrypt.compare(current, user.passwordHash))) back("That is not your current password.");
  if (password.length < 8) back("Use at least 8 characters.");
  if (password !== String(formData.get("confirm") || "")) back("Those passwords do not match.");
  if (password === current) back("Choose a different password.");
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await bcrypt.hash(password, 10) } });
  await endSessions(user.id, await currentSessionId());
  await audit(user.id, "PASSWORD_CHANGED", "user", user.id);
  await sendAlert(user.email, "Your UPB Capital password changed", "Your password was changed from the security page, and other devices were signed out. If this was not you, write the desk now.");
  redirect("/account/security?notice=password");
}

export async function revokeSession(formData: FormData) {
  const { person: user } = await requirePerson({ secondFactorSetup: true });
  const id = String(formData.get("id") || "");
  await prisma.serverSession.deleteMany({ where: { id, userId: user.id } });
  await audit(user.id, "SESSION_ENDED", "user", user.id);
  revalidatePath("/account/security");
  redirect("/account/security?notice=session");
}

export async function revokeOtherSessions() {
  const { person: user } = await requirePerson({ secondFactorSetup: true });
  await endSessions(user.id, await currentSessionId());
  await audit(user.id, "SESSIONS_ENDED", "user", user.id, "All other devices");
  revalidatePath("/account/security");
  redirect("/account/security?notice=sessions");
}
