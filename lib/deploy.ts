export const DEMO_EMAILS = [
  "iris@upbcapital.test",
  "maya.ellison@upbcapital.test",
  "desk@harborline.test",
  "jordan.hale@upbcapital.test",
  "camille.ortiz@upbcapital.test",
  "avery.chen@upbcapital.test",
  "credit@southshore.test",
  "nora.vale@upbcapital.test",
];

export const DEV_AUTH_SECRET = "dev-only-upb-capital-secret-change-me-1847";
export const DEV_DEMO_PASSWORD = "Desk1847!";

export const DEMO_LOGINS = [
  { role: "Desk admin", email: "iris@upbcapital.test" },
  { role: "Note seller", email: "maya.ellison@upbcapital.test" },
  { role: "Institution", email: "desk@harborline.test" },
  { role: "Buyer · Free", email: "jordan.hale@upbcapital.test" },
  { role: "Buyer · Pro", email: "camille.ortiz@upbcapital.test" },
  { role: "Broker", email: "nora.vale@upbcapital.test" },
];

export function demoSeedBlocked(env: Record<string, string | undefined>) {
  return env.VERCEL === "1" || env.NODE_ENV === "production" || env.UPB_RELEASE === "1";
}

export function assertDemoSeedAllowed(env: Record<string, string | undefined> = process.env) {
  if (!demoSeedBlocked(env)) return;
  throw new Error(
    "Demo seed is refused when VERCEL, UPB_RELEASE, or NODE_ENV=production is set. Production creates one admin with npm run db:bootstrap.",
  );
}

export function isReleaseBuild(env: Record<string, string | undefined>) {
  return env.VERCEL === "1" || env.UPB_RELEASE === "1";
}

// Production cookies are https-only. An internal server reached over plain http (pm2 on a port, no proxy)
// opts out with ALLOW_HTTP_SESSIONS=1; release builds refuse that setting.
export function secureCookies(env: Record<string, string | undefined> = process.env) {
  return env.NODE_ENV === "production" && env.ALLOW_HTTP_SESSIONS !== "1";
}

export function showDemoDesk(env: Record<string, string | undefined>, demoAccounts: number) {
  return !isReleaseBuild(env) && demoAccounts > 0;
}

// SynergyFund's database lives on the same Atlas cluster; UPB must never write into it.
const RESERVED_DATABASES = new Set(["admin", "local", "config", "synergifund"]);

export function assertMongoUrl(url: string | undefined) {
  if (!url) throw new Error("DATABASE_URL is required.");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("DATABASE_URL is not a valid URL.");
  }
  if (parsed.protocol !== "mongodb+srv:" && parsed.protocol !== "mongodb:") {
    throw new Error("DATABASE_URL must be a mongodb+srv:// or mongodb:// URL.");
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!database) throw new Error("DATABASE_URL must name the database, for example /upb_capital.");
  if (RESERVED_DATABASES.has(database.toLowerCase())) {
    throw new Error(`DATABASE_URL points at the ${database} database. UPB keeps its own, for example /upb_capital.`);
  }
}

export function remoteStorageConfigured(env: Record<string, string | undefined>) {
  const s3 = Boolean(env.S3_BUCKET && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY);
  const blob = Boolean(env.BLOB_READ_WRITE_TOKEN || env.BLOB_STORE_ID);
  return s3 || blob;
}

export function assertReleaseEnv(env: Record<string, string | undefined>) {
  const missing: string[] = [];
  if (!env.DATABASE_URL) missing.push("DATABASE_URL");
  if (!env.AUTH_SECRET) missing.push("AUTH_SECRET");
  if (!env.NEXT_PUBLIC_APP_URL) missing.push("NEXT_PUBLIC_APP_URL");
  if (!env.ADMIN_EMAIL) missing.push("ADMIN_EMAIL");
  if (!env.ADMIN_PASSWORD) missing.push("ADMIN_PASSWORD");
  if (!env.CRON_SECRET) missing.push("CRON_SECRET");
  if (!remoteStorageConfigured(env)) missing.push("S3_BUCKET + S3_ACCESS_KEY_ID + S3_SECRET_ACCESS_KEY, or BLOB_READ_WRITE_TOKEN");
  if (missing.length) throw new Error(`Production build is missing ${missing.join(", ")}.`);
  assertMongoUrl(env.DATABASE_URL);
  if ((env.AUTH_SECRET || "").length < 16 || env.AUTH_SECRET === DEV_AUTH_SECRET) {
    throw new Error("AUTH_SECRET must be a new random string of at least 16 characters.");
  }
  if ((env.CRON_SECRET || "").length < 16) throw new Error("CRON_SECRET must be at least 16 characters.");
  const email = (env.ADMIN_EMAIL || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("ADMIN_EMAIL is not an email address.");
  if (DEMO_EMAILS.includes(email) || email.endsWith("@upbcapital.test")) {
    throw new Error("ADMIN_EMAIL cannot be a demo account.");
  }
  const desk = (env.DESK_EMAIL || "").trim().toLowerCase();
  if (desk && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(desk)) throw new Error("DESK_EMAIL is not an email address.");
  if (DEMO_EMAILS.includes(desk) || desk.endsWith("@upbcapital.test")) {
    throw new Error("DESK_EMAIL cannot be a demo account.");
  }
  if ((env.ADMIN_PASSWORD || "").length < 12 || env.ADMIN_PASSWORD === DEV_DEMO_PASSWORD) {
    throw new Error("ADMIN_PASSWORD must be at least 12 characters and cannot be the demo password.");
  }
  const origin = env.NEXT_PUBLIC_APP_URL || "";
  if (!/^https:\/\//.test(origin)) throw new Error("NEXT_PUBLIC_APP_URL must be an https URL.");
  if (env.ALLOW_HTTP_SESSIONS === "1") throw new Error("ALLOW_HTTP_SESSIONS is for an internal http server. A release build serves https.");
}
