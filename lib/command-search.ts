import type { ListingStatus, Role } from "@prisma/client";
import { navFor } from "@/components/desk-nav";
import { canOpenListing, openableListingIds, type Viewer } from "@/lib/access";
import { deskPowers, type DeskCapability } from "@/lib/desk-roles";
import { literal } from "@/lib/db-filters";
import { deskSearch, searchTerm } from "@/lib/desk-search";
import { filtersFromSaved, filtersQuery } from "@/lib/filters";
import { moneyCompact, num } from "@/lib/format";
import { roleLabel } from "@/lib/labels";
import { loansForSale } from "@/lib/metrics";
import { prisma } from "@/lib/prisma";
import { getSettings, isPro } from "@/lib/settings";

// The ⌘K palette's data. Pages and actions are built here from the role and passed to the client. Search results
// come from searchCommands, scoped to what this viewer may open: a buyer finds only the public listings the book
// would open for them, a seller or broker only their own paper, and the desk everything.

export type CommandGroup =
  | "Recent"
  | "Actions"
  | "Pages"
  | "Listings"
  | "Your listings"
  | "Bids"
  | "Closings"
  | "Holdings"
  | "Saved views"
  | "Accounts"
  | "Borrowers"
  | "Leads";

export type CommandItem = {
  id: string;
  group: CommandGroup;
  label: string;
  hint?: string;
  href: string;
  keywords?: string;
  shortcut?: string[];
  // Opens something in the page instead of navigating.
  action?: "shortcuts";
  // Names a person. The palette never keeps it in recent items, which live in the browser.
  private?: boolean;
};

export type ShortcutBinding = { keys: string[]; label: string; href: string };

export type PaletteViewer = Viewer;

const PUBLIC: ListingStatus[] = ["APPROVED", "PENDING", "SOLD"];
const LIMIT = 8;

type Page = { href: string; label: string; keywords?: string };

// Search words for the desk's pages, which come from the sidebar itself (components/desk-nav.ts).
const DESK_KEYWORDS: Record<string, string> = {
  "/admin": "home dashboard",
  "/inbox": "messages threads",
  "/marketplace": "marketplace listings",
  "/admin/queue": "submissions approve",
  "/admin/offers": "bids inquiries",
  "/admin/events": "sale events auctions",
  "/admin/market": "hud fannie freddie",
  "/market": "report monthly",
  "/closings": "settlement checklist",
  "/admin/book": "holdings inventory",
  "/admin/verification": "verification kyc proof of funds",
  "/admin/users": "users people",
  "/admin/leads": "sellers prospects",
  "/admin/valuations": "valuation requests quotes",
  "/admin/payouts": "broker fees",
  "/admin/capital": "lenders funding",
  "/admin/settings": "settings fees commission",
  "/admin/compliance": "ofac screening",
  "/admin/templates": "templates documents",
  "/admin/audit": "history events",
  "/admin/blog": "blog posts",
  "/admin/analytics": "metrics digest",
  "/admin/jobs": "cron runs history failures",
  "/admin/assistant": "ai",
  "/seller/api": "keys developers",
  "/notifications": "notices alerts unread",
};

// The same pages as the sidebar in components/app-shell.tsx, in its order, plus the account menu's two pages. The
// desk's list is the sidebar's own, so a page the sidebar hides from a desk role is hidden here too.
export function navPages(role: Role | string, can?: readonly DeskCapability[]): Page[] {
  const notices: Page = { href: "/notifications", label: "Notifications", keywords: "notices alerts unread" };
  const account: Page[] = [
    { href: "/account/notifications", label: "Notice settings", keywords: "email push preferences digest" },
    { href: "/account/security", label: "Security", keywords: "password two-step authenticator sessions" },
  ];
  if (role === "ADMIN") {
    const desk = navFor({ role: "ADMIN", name: "", email: "", tier: "", unread: 0, ...(can ? { can } : {}) });
    return [...desk.map((item) => ({ href: item.href, label: item.label, keywords: DESK_KEYWORDS[item.href] })), ...account];
  }
  if (role === "BROKER") {
    return [
      { href: "/broker", label: "Desk", keywords: "home deals" },
      notices,
      { href: "/broker/deals/new", label: "File a deal", keywords: "new listing note" },
      { href: "/broker/profile", label: "Profile" },
      { href: "/closings", label: "Closings", keywords: "settlement checklist" },
      { href: "/inbox", label: "Inbox", keywords: "messages threads" },
      { href: "/market", label: "Market dispatch", keywords: "report monthly" },
      { href: "/fees", label: "Fee schedule", keywords: "fees commission" },
      ...account,
    ];
  }
  if (role === "BUYER") {
    return [
      { href: "/marketplace", label: "The book", keywords: "marketplace listings notes pools" },
      { href: "/events", label: "Events", keywords: "sale events auctions" },
      { href: "/market", label: "Market dispatch", keywords: "report monthly" },
      notices,
      { href: "/inbox", label: "Inbox", keywords: "messages threads" },
      { href: "/buyer/favorites", label: "Favorites", keywords: "watchlist saved" },
      { href: "/buyer/offers", label: "Inquiries", keywords: "offers bids questions" },
      { href: "/buyer/groups", label: "Groups", keywords: "group buy" },
      { href: "/closings", label: "Closings", keywords: "settlement checklist" },
      { href: "/buyer/portfolio", label: "Portfolio", keywords: "holdings owned" },
      { href: "/buyer/buy-box", label: "Buy box", keywords: "criteria standing bids" },
      { href: "/buyer/alerts", label: "Alerts", keywords: "saved searches" },
      { href: "/buyer/verification", label: "Verification", keywords: "kyc proof of funds" },
      { href: "/buyer/subscription", label: "Membership", keywords: "pro billing plan" },
      { href: "/fees", label: "Fee schedule", keywords: "fees premium" },
      ...account,
    ];
  }
  const pages: Page[] = [
    { href: "/seller", label: "Desk", keywords: "home listings" },
    notices,
    { href: "/seller/notes/new", label: "List a note", keywords: "new listing sell" },
    { href: "/inbox", label: "Inbox", keywords: "messages threads offers" },
    { href: "/closings", label: "Closings", keywords: "settlement checklist" },
    { href: "/market", label: "Market dispatch", keywords: "report monthly" },
    { href: "/fees", label: "Fee schedule", keywords: "fees commission" },
  ];
  if (role === "INSTITUTIONAL_SELLER") {
    pages.push({ href: "/seller/pools/new", label: "Upload a tape", keywords: "pool csv" });
    pages.push({ href: "/seller/api", label: "Seller API", keywords: "keys developers" });
  }
  return [...pages, ...account];
}

// "g" then a letter. Never bound to anything that binds, sends or pays: each one only opens a page.
export function shortcutsFor(role: Role | string): ShortcutBinding[] {
  const go = (key: string, label: string, href: string): ShortcutBinding => ({ keys: ["g", key], label, href });
  const common = [go("c", "Closings", "/closings"), go("i", "Inbox", "/inbox"), go("n", "Notifications", "/notifications")];
  if (role === "ADMIN") return [go("b", "The book", "/marketplace"), go("o", "Offers", "/admin/offers"), ...common];
  if (role === "BUYER") return [go("b", "The book", "/marketplace"), go("o", "Inquiries", "/buyer/offers"), ...common];
  if (role === "BROKER") return [go("b", "Your deals", "/broker"), ...common];
  return [go("b", "Your listings", "/seller"), ...common];
}

type PaletteUser = Pick<Viewer, "role" | "subscriptionTier" | "subscriptionStatus" | "subscriptionCurrentPeriodEnd"> & { deskRole?: string | null };

function actionsFor(viewer: PaletteUser, can: readonly DeskCapability[] | undefined): CommandItem[] {
  const items: CommandItem[] = [];
  const role = viewer.role;
  // Listing paper is the sales side's work on the desk.
  const lists = role !== "ADMIN" || !can || can.includes("sales");
  if ((role === "INDIVIDUAL_SELLER" || role === "INSTITUTIONAL_SELLER" || role === "ADMIN") && lists) {
    items.push({ id: "action:new-note", group: "Actions", label: "New note listing", href: "/seller/notes/new", keywords: "list a note sell create add" });
  }
  if ((role === "INSTITUTIONAL_SELLER" || role === "ADMIN") && lists) {
    items.push({ id: "action:tape", group: "Actions", label: "Upload a tape", href: "/seller/pools/new", keywords: "pool csv spreadsheet loans" });
  }
  if (role === "BROKER") {
    items.push({ id: "action:new-deal", group: "Actions", label: "File a deal", hint: "A new note listing for a client", href: "/broker/deals/new", keywords: "new note listing" });
  }
  if (role === "BUYER") {
    items.push(
      isPro(viewer)
        ? { id: "action:saved-views", group: "Actions", label: "Saved views", hint: "Filters you saved on the book", href: "/marketplace#saved-views", keywords: "searches alerts filters" }
        : { id: "action:saved-views", group: "Actions", label: "Saved views", hint: "Part of Pro", href: "/buyer/subscription", keywords: "searches alerts filters" },
    );
  }
  if (role === "ADMIN") {
    items.push({ id: "action:desk-search", group: "Actions", label: "Search the desk", hint: "Accounts, listings, borrowers, closings and leads", href: "/admin/search", keywords: "find lookup" });
  }
  items.push({ id: "action:shortcuts", group: "Actions", label: "Keyboard shortcuts", href: "#shortcuts", action: "shortcuts", shortcut: ["?"], keywords: "keys help" });
  return items;
}

// Everything the palette shows before a search: actions first, then the pages, each with its shortcut if it has one.
// A desk account's pages and actions follow its role, as the sidebar does.
export function paletteCommands(viewer: PaletteUser) {
  const can = viewer.role === "ADMIN" ? deskPowers({ role: viewer.role, deskRole: viewer.deskRole }) : undefined;
  const shortcuts = shortcutsFor(viewer.role);
  const keysFor = (href: string) => shortcuts.find((binding) => binding.href === href)?.keys;
  const pages: CommandItem[] = navPages(viewer.role, can).map((page) => ({
    id: `page:${page.href}`,
    group: "Pages",
    label: page.label,
    href: page.href,
    keywords: page.keywords,
    shortcut: keysFor(page.href),
  }));
  return { commands: [...actionsFor(viewer, can), ...pages], shortcuts, placeholder: placeholderFor(viewer.role) };
}

function placeholderFor(role: Role | string) {
  if (role === "ADMIN") return "Search the desk or jump to a page";
  if (role === "BUYER") return "Search the book, your bids and closings";
  if (role === "BROKER") return "Search your deals and closings";
  return "Search your listings and closings";
}

function idTerm(term: string) {
  return /^c[a-z0-9]{20,}$/i.test(term) ? term : null;
}

const statusWord: Record<string, string> = {
  APPROVED: "Live",
  PENDING: "In contract",
  SOLD: "Sold",
  SUBMITTED: "Submitted",
  UNDER_REVIEW: "In review",
  CHANGES_REQUESTED: "Changes requested",
  REJECTED: "Declined",
  WITHDRAWN: "Withdrawn",
};

function words(status: string) {
  return statusWord[status] ?? status.charAt(0) + status.slice(1).toLowerCase().replace(/_/g, " ");
}

type BookNote = { city: string; state: string; upb: number; askingPrice: number; tradeStatus: string };

// Kind, place and status, which the book shows every member. UPB and ask only when the viewer sees figures.
function listingHint(listing: { kind: string; status: string; notes: BookNote[] }, figures: boolean) {
  const forSale = loansForSale(listing.status, listing.notes);
  const states = [...new Set(forSale.map((note) => note.state))];
  const place = listing.kind === "POOL"
    ? `Pool · ${forSale.length} loan${forSale.length === 1 ? "" : "s"}${states.length ? ` · ${states.slice(0, 3).join(", ")}${states.length > 3 ? "…" : ""}` : ""}`
    : `Single note${forSale[0] ? ` · ${forSale[0].city}, ${forSale[0].state}` : ""}`;
  const parts = [place, words(listing.status)];
  if (figures) {
    const upb = forSale.reduce((sum, note) => sum + num(note.upb), 0);
    const ask = forSale.reduce((sum, note) => sum + num(note.askingPrice), 0);
    if (upb > 0) parts.push(`UPB ${moneyCompact(upb)}`);
    if (ask > 0) parts.push(`ask ${moneyCompact(ask)}`);
  }
  return parts.join(" · ");
}

function bidLabel(type: string) {
  if (type === "OFFER") return "Bid";
  if (type === "INFO_REQUEST") return "Question";
  return words(type);
}

type Settings = { earlyAccessHours: number; freeBrowseLimit: number };

// A buyer: public listings the book would open for them (early-access and free-slice holds applied by
// canOpenListing), with figures only for Pro; their own resales, bids, closings, holdings and saved views.
// Only fields the book shows every member are searched, never a street or a borrower.
async function buyerResults(viewer: PaletteViewer, term: string, settings: Settings): Promise<CommandItem[]> {
  const text = { contains: literal(term), mode: "insensitive" as const };
  const byId = idTerm(term);
  const approved = viewer.accountStatus === "APPROVED";
  const pro = isPro(viewer);
  const mine = await prisma.inquiry.findMany({ where: { buyerId: viewer.id }, select: { id: true } });
  const mineIds = mine.map((row) => row.id);
  const [book, found, resales, bids, closings, holdings, saved] = await Promise.all([
    approved ? prisma.listing.findMany({ where: { status: { in: PUBLIC } }, select: { id: true, status: true, approvedAt: true } }) : Promise.resolve([]),
    approved
      ? prisma.listing.findMany({
          where: {
            status: { in: PUBLIC },
            sellerId: { not: viewer.id },
            OR: [{ title: text }, { notes: { some: { OR: [{ city: text }, { state: text }] } } }, ...(byId ? [{ id: byId }] : [])],
          },
          select: {
            id: true,
            title: true,
            kind: true,
            status: true,
            approvedAt: true,
            sellerId: true,
            brokerId: true,
            launchAt: true,
            notes: { select: { city: true, state: true, upb: true, askingPrice: true, tradeStatus: true } },
          },
          orderBy: { approvedAt: "desc" },
          take: 60,
        })
      : Promise.resolve([]),
    prisma.listing.findMany({
      where: { sellerId: viewer.id, OR: [{ title: text }, ...(byId ? [{ id: byId }] : [])] },
      select: { id: true, title: true, status: true },
      orderBy: { updatedAt: "desc" },
      take: LIMIT,
    }),
    prisma.inquiry.findMany({
      where: { buyerId: viewer.id, OR: [{ listing: { title: text } }, ...(byId ? [{ id: byId }, { listingId: byId }] : [])] },
      select: { id: true, type: true, status: true, listing: { select: { title: true } } },
      orderBy: { createdAt: "desc" },
      take: LIMIT,
    }),
    prisma.closing.findMany({
      where: {
        AND: [
          { OR: [{ inquiryId: { in: mineIds } }, { funders: { some: { userId: viewer.id } } }] },
          { OR: [{ listing: { title: text } }, ...(byId ? [{ id: byId }] : [])] },
        ],
      },
      select: { id: true, status: true, listing: { select: { title: true } } },
      orderBy: { openedAt: "desc" },
      take: LIMIT,
    }),
    prisma.buyerHolding.findMany({
      where: { userId: viewer.id, title: text },
      select: { id: true, title: true, status: true },
      orderBy: { acquiredAt: "desc" },
      take: LIMIT,
    }),
    pro
      ? prisma.savedSearch.findMany({ where: { userId: viewer.id, name: text }, select: { id: true, name: true, filters: true }, take: LIMIT })
      : Promise.resolve([]),
  ]);
  const openable = openableListingIds(book, settings.earlyAccessHours, settings.freeBrowseLimit);
  const listings = found
    .filter((listing) =>
      canOpenListing({
        viewer,
        status: listing.status,
        approvedAt: listing.approvedAt,
        earlyAccessHours: settings.earlyAccessHours,
        openableIds: openable,
        listingId: listing.id,
        sellerId: listing.sellerId,
        brokerId: listing.brokerId,
        launchAt: listing.launchAt,
      }).ok,
    )
    .slice(0, LIMIT)
    .map<CommandItem>((listing) => ({
      id: `listing:${listing.id}`,
      group: "Listings",
      label: listing.title,
      hint: listingHint(listing, pro),
      href: `/marketplace/${listing.id}`,
    }));
  return [
    ...listings,
    ...resales.map<CommandItem>((listing) => ({ id: `resale:${listing.id}`, group: "Your listings", label: listing.title, hint: `Your resale · ${words(listing.status)}`, href: `/buyer/resales/${listing.id}` })),
    ...bids.map<CommandItem>((bid) => ({ id: `bid:${bid.id}`, group: "Bids", label: bid.listing.title, hint: `${bidLabel(bid.type)} · ${words(bid.status)}`, href: "/buyer/offers" })),
    ...closings.map<CommandItem>((closing) => ({ id: `closing:${closing.id}`, group: "Closings", label: closing.listing.title, hint: `Closing · ${words(closing.status)}`, href: `/closings/${closing.id}` })),
    ...holdings.map<CommandItem>((holding) => ({ id: `holding:${holding.id}`, group: "Holdings", label: holding.title, hint: `Holding · ${words(holding.status)}`, href: "/buyer/portfolio" })),
    ...saved.map<CommandItem>((search) => {
      const query = filtersQuery(filtersFromSaved(search.filters)).toString();
      return { id: `view:${search.id}`, group: "Saved views", label: search.name, hint: "Saved view", href: `/marketplace${query ? `?${query}` : ""}` };
    }),
  ];
}

// A seller: their own listings and the closings on them. A loan's street, borrower or loan number finds its listing,
// since the seller's own pages show them, but results show only the listing's title.
async function sellerResults(viewer: PaletteViewer, term: string): Promise<CommandItem[]> {
  const text = { contains: literal(term), mode: "insensitive" as const };
  const byId = idTerm(term);
  const [listings, closings] = await Promise.all([
    prisma.listing.findMany({
      where: {
        sellerId: viewer.id,
        OR: [
          { title: text },
          { notes: { some: { OR: [{ city: text }, { state: text }, { streetAddress: text }, { borrowerName: text }, { loanNumber: text }] } } },
          ...(byId ? [{ id: byId }] : []),
        ],
      },
      select: { id: true, title: true, status: true, kind: true },
      orderBy: { updatedAt: "desc" },
      take: LIMIT,
    }),
    prisma.closing.findMany({
      where: { listing: { sellerId: viewer.id }, OR: [{ listing: { title: text } }, ...(byId ? [{ id: byId }] : [])] },
      select: { id: true, status: true, listing: { select: { title: true } } },
      orderBy: { openedAt: "desc" },
      take: LIMIT,
    }),
  ]);
  return [
    ...listings.map<CommandItem>((listing) => ({ id: `listing:${listing.id}`, group: "Your listings", label: listing.title, hint: `${listing.kind === "POOL" ? "Pool" : "Single note"} · ${words(listing.status)}`, href: `/seller/listings/${listing.id}` })),
    ...closings.map<CommandItem>((closing) => ({ id: `closing:${closing.id}`, group: "Closings", label: closing.listing.title, hint: `Closing · ${words(closing.status)}`, href: `/closings/${closing.id}` })),
  ];
}

// A broker: deals they filed, and the closings the closings list shows them. A closing they only watch (as the
// listing's broker or the buyer's referrer) needs an approved seat, as on the closing page.
async function brokerResults(viewer: PaletteViewer, term: string): Promise<CommandItem[]> {
  const text = { contains: literal(term), mode: "insensitive" as const };
  const byId = idTerm(term);
  const approved = viewer.accountStatus === "APPROVED";
  const referred = approved
    ? (await prisma.inquiry.findMany({ where: { buyer: { referredById: viewer.id } }, select: { id: true } })).map((row) => row.id)
    : [];
  const [listings, closings] = await Promise.all([
    prisma.listing.findMany({
      where: {
        brokerId: viewer.id,
        OR: [
          { title: text },
          { clientSellerName: text },
          { notes: { some: { OR: [{ city: text }, { state: text }, { streetAddress: text }, { borrowerName: text }, { loanNumber: text }] } } },
          ...(byId ? [{ id: byId }] : []),
        ],
      },
      select: { id: true, title: true, status: true, kind: true },
      orderBy: { updatedAt: "desc" },
      take: LIMIT,
    }),
    prisma.closing.findMany({
      where: {
        AND: [
          {
            OR: [
              { listing: { sellerId: viewer.id } },
              ...(approved ? [{ listing: { brokerId: viewer.id } }, { inquiryId: { in: referred } }] : []),
            ],
          },
          { OR: [{ listing: { title: text } }, ...(byId ? [{ id: byId }] : [])] },
        ],
      },
      select: { id: true, status: true, listing: { select: { title: true } } },
      orderBy: { openedAt: "desc" },
      take: LIMIT,
    }),
  ]);
  return [
    ...listings.map<CommandItem>((listing) => ({ id: `listing:${listing.id}`, group: "Your listings", label: listing.title, hint: `${listing.kind === "POOL" ? "Pool" : "Single note"} · ${words(listing.status)}`, href: `/broker/deals/${listing.id}` })),
    ...closings.map<CommandItem>((closing) => ({ id: `closing:${closing.id}`, group: "Closings", label: closing.listing.title, hint: `Closing · ${words(closing.status)}`, href: `/closings/${closing.id}` })),
  ];
}

// The desk: lib/desk-search.ts, the same lookup and links as /admin/search, borrowers included.
async function deskResults(term: string): Promise<CommandItem[]> {
  const found = await deskSearch(term);
  if (!found) return [];
  return [
    ...found.listings.map<CommandItem>((listing) => ({ id: `listing:${listing.id}`, group: "Listings", label: listing.title, hint: `${listing.kind === "POOL" ? "Pool" : "Single note"} · ${words(listing.status)}`, href: `/admin/listings/${listing.id}` })),
    ...found.closings.map<CommandItem>((closing) => ({ id: `closing:${closing.id}`, group: "Closings", label: closing.listing.title, hint: `Closing · ${words(closing.status)}`, href: `/closings/${closing.id}` })),
    ...found.users.map<CommandItem>((user) => ({ id: `user:${user.id}`, group: "Accounts", label: user.name, hint: `${user.email} · ${roleLabel(user.role)}`, href: `/admin/users?q=${encodeURIComponent(user.email)}`, private: true })),
    ...found.borrowerNotes.map<CommandItem>((note, index) => ({ id: `borrower:${note.listingId}:${index}`, group: "Borrowers", label: note.borrowerName || "Unnamed borrower", hint: `${note.city}, ${note.state} · ${note.listing.title}`, href: `/admin/listings/${note.listingId}`, private: true })),
    ...found.leads.map<CommandItem>((lead) => ({ id: `lead:${lead.id}`, group: "Leads", label: lead.name, hint: `${lead.email} · ${words(lead.status)}`, href: "/admin/leads", private: true })),
  ];
}

// The search behind /api/command. Settings can be passed in so a test can fix the holds.
export async function searchCommands(viewer: PaletteViewer, raw: string, options: { settings?: Settings } = {}): Promise<CommandItem[]> {
  const term = searchTerm(typeof raw === "string" ? raw : "");
  if (term.length < 2) return [];
  if (viewer.accountStatus === "REJECTED" || viewer.accountStatus === "SUSPENDED") return [];
  if (viewer.role === "ADMIN") return deskResults(term);
  if (viewer.role === "BUYER") {
    const settings = options.settings ?? (await getSettings());
    return buyerResults(viewer, term, { earlyAccessHours: settings.earlyAccessHours, freeBrowseLimit: settings.freeBrowseLimit });
  }
  if (viewer.role === "BROKER") return brokerResults(viewer, term);
  if (viewer.role === "INDIVIDUAL_SELLER" || viewer.role === "INSTITUTIONAL_SELLER") return sellerResults(viewer, term);
  return [];
}
