"use server";

import { createHash, randomInt } from "crypto";
import { redirect } from "next/navigation";
import { clearPending, pendingUserId, requireUser, setSession } from "@/lib/auth";
import { notify } from "@/lib/email";
import { homeFor } from "@/lib/labels";
import { prisma } from "@/lib/prisma";
import { consumeRateLimit } from "@/lib/rate-limit";
import { newRecoveryCodes, packHashes, takeRecoveryCode } from "@/lib/recovery";
import { generateTotpSecret, verifyTotp } from "@/lib/totp";

export async function beginTotp() {
  const user = await requireUser();
  if (user.totpEnabled) redirect("/account/security");
  const secret = generateTotpSecret();
  await prisma.user.update({ where: { id: user.id }, data: { totpSecret: secret, totpEnabled: false } });
  redirect("/account/security?notice=totp");
}

export async function confirmTotp(formData: FormData) {
  const user = await requireUser();
  const code = String(formData.get("code") || "");
  if (!user.totpSecret || !verifyTotp(user.totpSecret, code)) {
    redirect("/account/security?error=" + encodeURIComponent("That code does not match the secret on this account."));
  }
  const codes = newRecoveryCodes();
  await prisma.user.update({
    where: { id: user.id },
    data: { totpEnabled: true, recoveryHashes: packHashes(codes), recoveryReveal: codes.join("\n") },
  });
  redirect("/account/security?notice=codes");
}

export async function acknowledgeRecovery() {
  const user = await requireUser();
  await prisma.user.update({ where: { id: user.id }, data: { recoveryReveal: "" } });
  redirect("/account/security?notice=totp_on");
}

export async function disableTotp(formData: FormData) {
  const user = await requireUser();
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
  redirect("/account/security?notice=totp_off");
}

export async function setEmailFallback(formData: FormData) {
  const user = await requireUser();
  if (!user.totpEnabled) redirect("/account/security");
  await prisma.user.update({ where: { id: user.id }, data: { emailOtpFallback: formData.get("enabled") === "yes" } });
  redirect("/account/security?notice=email_otp");
}

async function acceptSecondFactor(user: { id: string; totpSecret: string; recoveryHashes: string; email: string }, code: string) {
  if (verifyTotp(user.totpSecret, code)) return true;
  const remaining = takeRecoveryCode(user.recoveryHashes, code);
  if (remaining != null) {
    await prisma.user.update({ where: { id: user.id }, data: { recoveryHashes: remaining } });
    return true;
  }
  const hash = createHash("sha256").update(code.replace(/\s/g, "")).digest("hex");
  const row = await prisma.loginCode.findFirst({
    where: { userId: user.id, codeHash: hash, usedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
  if (!row) return false;
  await prisma.loginCode.update({ where: { id: row.id }, data: { usedAt: new Date() } });
  return true;
}

export async function verifyLoginTotp(formData: FormData) {
  const userId = await pendingUserId();
  if (!userId) redirect("/login?error=" + encodeURIComponent("Sign in again, then enter the code."));
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !user.totpEnabled) redirect("/login");
  if (!(await consumeRateLimit(`totp:${user.id}`, 5, 15 * 60 * 1000))) {
    redirect("/login/verify?error=" + encodeURIComponent("Too many codes. Wait fifteen minutes and try again."));
  }
  const code = String(formData.get("code") || "");
  if (!(await acceptSecondFactor(user, code))) {
    redirect("/login/verify?error=" + encodeURIComponent("That code is not current."));
  }
  await clearPending();
  await setSession({ sub: user.id, email: user.email, role: user.role, name: user.name });
  const fallback = user.role === "BUYER" && user.accountStatus !== "APPROVED" ? "/buyer/pending" : homeFor(user.role);
  redirect(fallback);
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
  await notify(user.email, "Your UPB Capital sign-in code", `Your code is ${code}. It expires in ten minutes.`);
  redirect("/login/verify?notice=email_sent");
}
