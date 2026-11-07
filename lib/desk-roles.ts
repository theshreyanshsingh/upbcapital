// The desk roles and what each may do, with no server imports, so the bid rules in lib/auction.ts and the client
// navigation can read them. lib/staff.ts re-exports all of it with the checks that need a session or the database.

export const DESK_ROLES = ["OWNER", "SALES", "CLOSINGS", "COMPLIANCE", "TRADER", "ANALYST"] as const;
export type DeskRole = (typeof DESK_ROLES)[number];

export type DeskCapability =
  // Review queue, listing edits, sale events, offers, seller approvals and awards.
  | "sales"
  // Sealed and best-and-final amounts before the deadline, and the ranked bid sheet.
  | "sealedBids"
  // Closings: steps, files, wires recorded, boarding, borrower notices, kick-outs.
  | "closings"
  // Approving a wire change someone else proposed.
  | "approveWires"
  // Buyer and seller files, sanctions decisions, strikes, deletion requests, the audit log.
  | "compliance"
  // Bidding and holding for UPB's own book, and the desk's capital.
  | "deskBook"
  // Fees, settings, legal texts, forms, staff roles and invitations.
  | "admin"
  // Content: blog, testimonials, market dispatch, agency sales.
  | "content";

const POWERS: Record<DeskRole, readonly DeskCapability[]> = {
  OWNER: ["sales", "sealedBids", "closings", "approveWires", "compliance", "deskBook", "admin", "content"],
  SALES: ["sales", "sealedBids", "content"],
  CLOSINGS: ["closings", "approveWires"],
  COMPLIANCE: ["compliance", "approveWires"],
  // The book's buyer never sees a sealed bid: a trader who could would bid against the sellers' own bidders.
  TRADER: ["deskBook"],
  ANALYST: [],
};

export const DESK_ROLE_LABELS: Record<DeskRole, string> = {
  OWNER: "Owner",
  SALES: "Sales",
  CLOSINGS: "Closings",
  COMPLIANCE: "Compliance",
  TRADER: "Desk book",
  ANALYST: "Read only",
};

// One line each, for the staff table, in the words the desk uses.
export const DESK_ROLE_HINTS: Record<DeskRole, string> = {
  OWNER: "Everything, including fees, settings and staff roles.",
  SALES: "Listings, offers, sealed bids and awards.",
  CLOSINGS: "Closings and wires. Approves wire changes.",
  COMPLIANCE: "Buyer files, sanctions, strikes and the audit log. Approves wire changes.",
  TRADER: "Bids and holds for UPB's own book. Never sees sealed bids.",
  ANALYST: "Reads every desk page and changes nothing.",
};

export type Staff = { role: string; deskRole?: string | null };

export function isDeskRole(value: unknown): value is DeskRole {
  return typeof value === "string" && (DESK_ROLES as readonly string[]).includes(value);
}

export function deskRoleOf(user: Staff): DeskRole | null {
  if (user.role !== "ADMIN") return null;
  return isDeskRole(user.deskRole) ? user.deskRole : "OWNER";
}

export function deskCan(user: Staff | null | undefined, capability: DeskCapability) {
  if (!user) return false;
  const role = deskRoleOf(user);
  return role != null && POWERS[role].includes(capability);
}

// What a desk account may do, for pages that hide the forms it can't use. Empty for everyone else.
export function deskPowers(user: Staff | null | undefined): DeskCapability[] {
  const role = user ? deskRoleOf(user) : null;
  return role ? [...POWERS[role]] : [];
}

// Any write at all. A read-only account leaves desk notes and threads alone too.
export function deskWrites(user: Staff | null | undefined) {
  return deskPowers(user).length > 0;
}

export const DESK_DENIED = "Your desk role doesn't cover this. Ask an owner to change it.";

// The named deal owner: any desk account that runs sales or closings.
export function canOwnDeals(user: Staff) {
  return deskCan(user, "sales") || deskCan(user, "closings");
}
