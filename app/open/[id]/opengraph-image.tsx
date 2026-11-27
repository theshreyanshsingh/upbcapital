import { ImageResponse } from "next/og";
import { INK, PAPER } from "@/app/icons/mark";
import { getCurrentUser } from "@/lib/auth";
import { cardFacts, glyphs, statesLine, type CardFacts } from "@/lib/share-cards";

// The preview image LinkedIn, X, Slack and mail apps show for a teaser link (lib/share-cards.ts). It shows only what
// the public page shows. A private, excluded, missing or not-live listing gets the generic UPB Capital card, never a
// not-found that would tell anyone the listing exists. Next serves it at /open/[id]/opengraph-image and names it in
// the page's og:image, and the page's twitter:image follows it.

export const alt = "UPB Capital listing card: the city and state, lien, payment status and UPB band of an anonymized mortgage note";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const dynamic = "force-dynamic";

// The light theme's tokens in app/globals.css, as hex, since the renderer can't read CSS variables: --background,
// --card, --foreground, --muted-foreground, --border, --brand, --good and --warn. The ink tile and its letter are the
// mark's in app/icons/mark.tsx.
const PAGE = "#f6f5f2";
const CARD = "#fefefd";
const TEXT = "#1c1915";
const MUTED = "#635e58";
const BORDER = "#e0deda";
const BRAND = "#275da2";
const GOOD = "#266f40";
const WARN = "#8a5818";
const U_PATH = "M11.75 9.8V16.6a4.25 4.25 0 0 0 8.5 0V9.8";

// A long city name steps the title down so it fits on a line or two.
function titleSize(text: string) {
  return Math.max(60, Math.min(104, Math.floor(1072 / (text.length * 0.56))));
}

export default async function Image({ params }: { params: Promise<{ id: string }> | { id: string } }) {
  const { id } = await params;
  // A signed-out fetch, as a social site's is, reads the page's signed-out rule. Outside a request there is no viewer.
  const viewer = await getCurrentUser().catch(() => null);
  const facts = await cardFacts(String(id ?? ""), viewer);
  return new ImageResponse(facts ? <ListingCard facts={facts} /> : <GenericCard />, {
    ...size,
    // Kept short and per viewer, so a listing that goes private or sells stops showing its facts.
    headers: { "cache-control": "private, max-age=300" },
  });
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: 64, background: PAGE, color: TEXT }}>
      {children}
    </div>
  );
}

function Brand() {
  return (
    <div style={{ display: "flex", alignItems: "center" }}>
      <div style={{ width: 60, height: 60, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 17, background: INK }}>
        <svg width={60} height={60} viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
          <path d={U_PATH} fill="none" stroke={PAPER} strokeWidth={2.7} />
        </svg>
      </div>
      <div style={{ marginLeft: 20, fontSize: 36, letterSpacing: -0.5 }}>UPB Capital</div>
    </div>
  );
}

function Fact({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", padding: "22px 26px", background: CARD, border: `2px solid ${BORDER}`, borderRadius: 18 }}>
      <div style={{ fontSize: 24, color: MUTED }}>{k}</div>
      <div style={{ marginTop: 8, fontSize: 40, letterSpacing: -0.5 }}>{glyphs(v)}</div>
    </div>
  );
}

function ListingCard({ facts }: { facts: CardFacts }) {
  const live = facts.status === "Live on the desk";
  const kicker = facts.pool ? `Pool · ${facts.loans} loans across ${statesLine(facts.states)}` : "Single note";
  const place = glyphs(facts.place);
  return (
    <Frame>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <Brand />
        <div style={{ display: "flex", alignItems: "center", padding: "12px 24px", background: CARD, border: `2px solid ${BORDER}`, borderRadius: 999 }}>
          <div style={{ width: 16, height: 16, borderRadius: 8, background: live ? GOOD : WARN }} />
          <div style={{ marginLeft: 14, fontSize: 28 }}>{facts.status}</div>
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        <div style={{ fontSize: 30, color: BRAND }}>{glyphs(kicker)}</div>
        <div style={{ marginTop: 10, fontSize: titleSize(place), lineHeight: 1.05, letterSpacing: -2 }}>{place}</div>
      </div>
      <div style={{ display: "flex", gap: 20 }}>
        <Fact k="Lien" v={facts.lien} />
        <Fact k="Payment status" v={facts.payment} />
        <Fact k={facts.pool ? "Total UPB band" : "UPB band"} v={facts.band} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 26, color: MUTED }}>
        <div>Verified buyers bid on UPB Capital</div>
        <div>Street, borrower and price stay on the desk</div>
      </div>
    </Frame>
  );
}

function GenericCard() {
  return (
    <Frame>
      <Brand />
      <div style={{ display: "flex", flexDirection: "column" }}>
        <div style={{ fontSize: 84, lineHeight: 1.08, letterSpacing: -2 }}>A private market for mortgage notes</div>
        <div style={{ marginTop: 24, fontSize: 34, color: MUTED }}>Priced against unpaid principal balance.</div>
      </div>
      <div style={{ display: "flex", fontSize: 28, color: BRAND }}>Verified buyers bid on UPB Capital</div>
    </Frame>
  );
}
