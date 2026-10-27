"use server";

import bcrypt from "bcryptjs";
import { redirect } from "next/navigation";
import { z } from "zod";
import { clearSession, setPending, setSession } from "@/lib/auth";
import { notifyDesk } from "@/lib/email";
import { homeFor } from "@/lib/labels";
import { prisma } from "@/lib/prisma";
import { consumeRateLimit } from "@/lib/rate-limit";
import { referralCodeFor } from "@/lib/referral";
import { requestMeta } from "@/lib/request-meta";
import { firstZodError } from "@/lib/validators";

const signupSchema = z.object({
  role: z.enum(["INDIVIDUAL_SELLER", "INSTITUTIONAL_SELLER", "BUYER", "BROKER"]),
  name: z.string().trim().min(2, "Enter your name."),
  email: z.string().trim().email("Enter a valid email.").transform((value) => value.toLowerCase()),
  password: z.string().min(8, "Use at least 8 characters."),
  phone: z.string().trim().optional().or(z.literal("")),
  companyName: z.string().trim().optional().or(z.literal("")),
  companyType: z.enum(["BANK", "FUND", "SERVICER", "OTHER"]).optional().or(z.literal("")),
  referral: z.string().trim().optional().or(z.literal("")),
});

function safeNext(value: string, fallback: string) {
  if (value.startsWith("/") && !value.startsWith("//")) return value;
  return fallback;
}

async function uniqueReferralCode(name: string) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const code = referralCodeFor(name);
    const taken = await prisma.user.findUnique({ where: { referralCode: code } });
    if (!taken) return code;
  }
  return referralCodeFor(`${name}${Date.now()}`);
}

export async function signup(_prev: { error: string }, formData: FormData) {
  const meta = await requestMeta();
  if (!(await consumeRateLimit(`signup:${meta.ipAddress}`, 8, 60 * 60 * 1000))) {
    return { error: "Too many new accounts from this network. Wait and try again." };
  }
  const parsed = signupSchema.safeParse({
    role: formData.get("role"),
    name: formData.get("name"),
    email: formData.get("email"),
    password: formData.get("password"),
    phone: formData.get("phone") || "",
    companyName: formData.get("companyName") || "",
    companyType: formData.get("companyType") || undefined,
    referral: formData.get("referral") || "",
  });
  if (!parsed.success) return { error: firstZodError(parsed.error) };
  const data = parsed.data;
  if (data.role === "INSTITUTIONAL_SELLER" && !data.companyName) {
    return { error: "Institutional accounts need a company name." };
  }
  const existing = await prisma.user.findUnique({ where: { email: data.email } });
  if (existing) return { error: "An account with that email is already on the desk." };
  const code = (data.referral || "").trim().toUpperCase();
  const referrer = code ? await prisma.user.findUnique({ where: { referralCode: code } }) : null;
  if (code && !referrer) return { error: "That referral code is not on the desk." };
  if (referrer?.role === "BROKER" && referrer.accountStatus !== "APPROVED") {
    return { error: "That broker is not approved to take introductions yet." };
  }

  const approved = data.role === "INDIVIDUAL_SELLER";
  const user = await prisma.user.create({
    data: {
      email: data.email,
      name: data.name,
      passwordHash: await bcrypt.hash(data.password, 10),
      role: data.role,
      accountStatus: approved ? "APPROVED" : "PENDING",
      phone: data.phone || "",
      companyName: data.companyName || "",
      companyType: data.companyType ? data.companyType : null,
      referralCode: await uniqueReferralCode(data.name),
      referredById: referrer?.id,
    },
  });

  if (data.role === "BROKER") {
    await prisma.brokerProfile.create({ data: { userId: user.id, company: data.companyName || "" } });
  }

  if (!approved) {
    await notifyDesk(
      `Account waiting: ${user.name}`,
      `${user.name} (${user.email}) signed up as ${user.role}${user.companyName ? ` · ${user.companyName}` : ""}. Approve them from the desk.`,
    );
  }

  const leadId = String(formData.get("lead") || "");
  if (leadId) {
    await prisma.sellerLead.updateMany({
      where: { id: leadId, email: user.email },
      data: { userId: user.id, status: "LISTING" },
    });
  }
  await setSession({ sub: user.id, email: user.email, role: user.role, name: user.name });
  if (user.role === "BUYER") redirect("/buyer/pending");
  if (user.role === "BROKER") redirect("/broker/onboarding");
  if (user.role === "INDIVIDUAL_SELLER") redirect(leadId ? `/seller/notes/new?lead=${leadId}` : "/seller/notes/new");
  redirect("/seller");
}

export async function login(_prev: { error: string }, formData: FormData) {
  const email = String(formData.get("email") || "").trim().toLowerCase();
  const password = String(formData.get("password") || "");
  const meta = await requestMeta();
  if (!(await consumeRateLimit(`login:${meta.ipAddress}:${email}`, 8, 10 * 60 * 1000))) {
    return { error: "Too many sign-in attempts. Wait a few minutes and try again." };
  }
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return { error: "Those credentials are not on the desk." };
  }
  if (user.accountStatus === "REJECTED") {
    return { error: "This account was declined. Write the desk if that is a mistake." };
  }
  if (user.totpEnabled && user.totpSecret) {
    await setPending(user.id);
    redirect("/login/verify");
  }
  await setSession({ sub: user.id, email: user.email, role: user.role, name: user.name });
  const fallback = user.role === "BUYER" && user.accountStatus !== "APPROVED" ? "/buyer/pending" : homeFor(user.role);
  redirect(safeNext(String(formData.get("next") || ""), fallback));
}

export async function logout() {
  await clearSession();
  redirect("/");
}
