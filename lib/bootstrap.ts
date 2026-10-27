import bcrypt from "bcryptjs";
import { FLORIDA_DISCLOSURE } from "./compliance";
import { assertReleaseEnv, DEMO_EMAILS } from "./deploy";
import { prisma } from "./prisma";

export async function bootstrapProduction(env: Record<string, string | undefined> = process.env) {
  assertReleaseEnv(env);
  const demo = await prisma.user.count({ where: { email: { in: DEMO_EMAILS } } });
  if (demo > 0) {
    throw new Error("Demo accounts are already in this database. Refusing to treat it as production.");
  }
  const email = env.ADMIN_EMAIL!.trim().toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    if (existing.role !== "ADMIN" || existing.accountStatus !== "APPROVED") {
      throw new Error("ADMIN_EMAIL already belongs to an account that is not an approved admin.");
    }
    console.log(`Admin ${email} already exists. Password was left unchanged.`);
  } else {
    await prisma.user.create({
      data: {
        email,
        name: env.ADMIN_NAME?.trim() || "Desk admin",
        role: "ADMIN",
        accountStatus: "APPROVED",
        passwordHash: await bcrypt.hash(env.ADMIN_PASSWORD!, 10),
      },
    });
    console.log(`Created admin ${email}.`);
  }
  await prisma.stateDisclosure.upsert({
    where: { state: FLORIDA_DISCLOSURE.state },
    create: { state: FLORIDA_DISCLOSURE.state, license: FLORIDA_DISCLOSURE.license, body: FLORIDA_DISCLOSURE.body },
    update: {},
  });
  await prisma.platformSettings.upsert({
    where: { id: "default" },
    create: { id: "default" },
    update: {},
  });
}
