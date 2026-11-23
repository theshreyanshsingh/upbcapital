import { deliverable } from "./mail-config";

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

// The demo desk's own addresses: the seeded seats and anything else on its domain.
export function demoAddress(email: string) {
  const address = email.trim().toLowerCase();
  return DEMO_EMAILS.includes(address) || address.endsWith("@upbcapital.test");
}

// The seeded seats share one password and skip the second factor, because one visitor enrolling would lock out the
// rest. A real signup on some other reserved domain is not a seat, and a release build has none.
export function demoSeat(email: string, env: Record<string, string | undefined> = process.env) {
  return !isReleaseBuild(env) && demoAddress(email);
}

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

// The server's own address is on this machine or a reserved test name: NEXT_PUBLIC_APP_URL unset or empty, or a host
// of localhost, 127.0.0.1, [::1], *.localhost or *.test. An address that doesn't parse is not local.
export function localOrigin(appUrl: string | undefined) {
  const value = (appUrl || "").trim();
  if (!value) return true;
  let host: string;
  try {
    host = new URL(value).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return false;
  }
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost") || host.endsWith(".test");
}

// The seeded seats share a password that is public in the repository, so they work only where the public can't reach
// them: on a local origin, or on a private demo server that opts in with DEMO_DESK=1. A release build has none.
export function demoDeskOpen(env: Record<string, string | undefined> = process.env) {
  return !isReleaseBuild(env) && (env.DEMO_DESK === "1" || localOrigin(env.NEXT_PUBLIC_APP_URL));
}

// A demo address this server keeps out: a demo build on a public origin without DEMO_DESK=1. Sign-in refuses it, and
// its sessions, API keys, calendar links and guest links stop working. A release build is left as it was; its
// bootstrap refuses a database that holds demo seats.
export function demoSeatShut(email: string | null | undefined, env: Record<string, string | undefined> = process.env) {
  return !isReleaseBuild(env) && !demoDeskOpen(env) && demoAddress(email || "");
}

export const DEMO_SEAT_SHUT = "The demo accounts only sign in on a local copy of the desk. Sign in with your own account.";

export function showDemoDesk(env: Record<string, string | undefined>, demoAccounts: number) {
  return demoDeskOpen(env) && demoAccounts > 0;
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
  if (!env.OFAC_SDN_URL && !(env.OFAC_API_URL && env.OFAC_API_KEY)) missing.push("OFAC_SDN_URL, or OFAC_API_URL + OFAC_API_KEY");
  if (missing.length) throw new Error(`Production build is missing ${missing.join(", ")}.`);
  assertMongoUrl(env.DATABASE_URL);
  // Screening finds aliases in ALT.CSV beside SDN.CSV (aliasUrl in lib/ofac), so the address has to name SDN.CSV.
  if (env.OFAC_SDN_URL && !/\/sdn\.csv$/i.test(URL.canParse(env.OFAC_SDN_URL) ? new URL(env.OFAC_SDN_URL).pathname : "")) {
    throw new Error("OFAC_SDN_URL must be the address of SDN.CSV, so the alias list beside it can load.");
  }
  if ((env.AUTH_SECRET || "").length < 16 || env.AUTH_SECRET === DEV_AUTH_SECRET) {
    throw new Error("AUTH_SECRET must be a new random string of at least 16 characters.");
  }
  if ((env.CRON_SECRET || "").length < 16) throw new Error("CRON_SECRET must be at least 16 characters.");
  const email = (env.ADMIN_EMAIL || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("ADMIN_EMAIL is not an email address.");
  if (demoAddress(email)) {
    throw new Error("ADMIN_EMAIL cannot be a demo account.");
  }
  // A release mails its admin codes, resets and alerts, so a reserved test domain won't do.
  if (isReleaseBuild(env) && !deliverable(email)) throw new Error("ADMIN_EMAIL must be an address that takes mail.");
  const desk = (env.DESK_EMAIL || "").trim().toLowerCase();
  if (desk && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(desk)) throw new Error("DESK_EMAIL is not an email address.");
  if (demoAddress(desk)) {
    throw new Error("DESK_EMAIL cannot be a demo account.");
  }
  if (desk && isReleaseBuild(env) && !deliverable(desk)) throw new Error("DESK_EMAIL must be an address that takes mail.");
  if ((env.ADMIN_PASSWORD || "").length < 12 || env.ADMIN_PASSWORD === DEV_DEMO_PASSWORD) {
    throw new Error("ADMIN_PASSWORD must be at least 12 characters and cannot be the demo password.");
  }
  const origin = env.NEXT_PUBLIC_APP_URL || "";
  if (!/^https:\/\//.test(origin)) throw new Error("NEXT_PUBLIC_APP_URL must be an https URL.");
  if (env.ALLOW_HTTP_SESSIONS === "1") throw new Error("ALLOW_HTTP_SESSIONS is for an internal http server. A release build serves https.");
}
