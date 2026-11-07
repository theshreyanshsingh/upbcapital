"use client";

import { useCallback, useId, useSyncExternalStore } from "react";
import Link from "next/link";
import { submitInquiry } from "@/actions/buyer";
import { ConfirmRows, ConfirmSubmit } from "@/components/confirm-submit";
import { EntityField, entityRows, useEntityChoice, type EntityOption } from "@/components/entity-picker";
import { flatTerms, premiumOn, type FeeTerms } from "@/lib/fee-schedule";
import { money } from "@/lib/format";
import { bidTerms, goodUntilRow } from "@/lib/offers";
import { bidTarget, credentialRows, headroomAfter, type BidStanding } from "@/lib/verification";

// The pool tape renders each loan's box twice, as a phone card and as a table row, with one showing at a time. Both
// read one draft per loan, so a bid typed in one is still there when a rotation swaps to the other. The draft goes
// once neither box is on the page.
type Draft = { amount: string; goodUntil: string };
const EMPTY: Draft = { amount: "", goodUntil: "" };
const drafts = new Map<string, Draft>();
const watchers = new Map<string, Set<() => void>>();

function watch(key: string, onChange: () => void) {
  let set = watchers.get(key);
  if (!set) watchers.set(key, (set = new Set()));
  set.add(onChange);
  return () => {
    set.delete(onChange);
    if (set.size === 0) {
      watchers.delete(key);
      drafts.delete(key);
    }
  };
}

function useDraft(key: string) {
  // One subscription per box for the life of its loan, so a re-render never drops the last watcher and the draft.
  const subscribe = useCallback((onChange: () => void) => watch(key, onChange), [key]);
  const draft = useSyncExternalStore(subscribe, () => drafts.get(key) ?? EMPTY, () => EMPTY);
  const update = (patch: Partial<Draft>) => {
    drafts.set(key, { ...(drafts.get(key) ?? EMPTY), ...patch });
    watchers.get(key)?.forEach((onChange) => onChange());
  };
  return [draft, update] as const;
}

export function LoanBid({
  listingId,
  noteId,
  premiumBps,
  fees,
  verified,
  closed,
  loanName,
  deposit,
  diligenceDays,
  notices = [],
  standing = null,
  entities = [],
}: {
  listingId: string;
  noteId: string;
  premiumBps: number;
  // The listing's fee terms, so a graded premium follows the figure typed. Missing means premiumBps flat.
  fees?: FeeTerms;
  verified: boolean;
  closed: boolean;
  // What screen readers hear for this box, and what the confirmation names: "the loan in Tampa, FL".
  loanName: string;
  deposit?: [number, number];
  diligenceDays?: number;
  // This loan's eligibility notices, restated in the confirmation. The server checks the acknowledgement either way.
  notices?: string[];
  // The buyer's verified-funds credential and any strike pause, from bidStanding in lib/inquiry.
  standing?: BidStanding | null;
  // The buying entities a bid can be for. The buyer picks one in the bid panel, and every loan box carries it.
  entities?: EntityOption[];
}) {
  // The tape renders this box twice, as a phone card and as a table row, so the field ids come from useId.
  const ids = useId();
  const [{ amount, goodUntil }, updateDraft] = useDraft(`${listingId}:${noteId}`);
  const [entity] = useEntityChoice(listingId, entities);
  const offer = Number(amount.replace(/[$,]/g, ""));
  const premium = premiumOn(fees ?? flatTerms(premiumBps), offer);
  const credential = standing?.credential ?? null;
  const room = offer > 0 ? headroomAfter(credential, bidTarget(listingId, noteId), offer + premium) : null;
  if (closed) return <span className="text-[13px] font-medium text-muted-foreground">Closed</span>;
  if (!verified) {
    return (
      <Link href="/buyer/verification" className="text-[13px] font-medium text-link">
        Verify to bid
      </Link>
    );
  }
  // The buyer file says why: strikes under review, or a proof of funds to renew.
  if (standing?.paused || credential?.expired) {
    return (
      <Link href="/buyer/verification" className="text-[13px] font-medium text-link">
        {standing?.paused ? "Bidding paused" : "Renew funds to bid"}
      </Link>
    );
  }
  return (
    <form action={submitInquiry} className="flex min-w-40 flex-col gap-1">
      <input type="hidden" name="listingId" value={listingId} />
      <input type="hidden" name="noteId" value={noteId} />
      <input type="hidden" name="type" value="OFFER" />
      <input type="hidden" name="message" value="Loan-level bid." />
      <EntityField chosen={entity} />
      <label className="text-xs text-muted-foreground" htmlFor={`${ids}-bid`}>Your bid<span className="sr-only"> for {loanName}</span></label>
      <input
        id={`${ids}-bid`}
        name="amount"
        inputMode="decimal"
        required
        value={amount}
        onChange={(event) => updateDraft({ amount: event.target.value })}
        placeholder="Bid this loan"
        className="desk-input h-9 px-2 tabular-nums max-md:h-11 max-md:px-3"
      />
      {premium > 0 && <span className="text-xs text-muted-foreground tabular-nums">All-in {money(offer + premium)}</span>}
      {room != null && <span className={`text-xs tabular-nums ${room < 0 ? "text-bad" : "text-muted-foreground"}`}>{room < 0 ? `Over your funds by ${money(-room)}` : `Headroom after ${money(room)}`}</span>}
      <label className="text-xs text-muted-foreground" htmlFor={`${ids}-until`}>Good until (optional)</label>
      <input
        id={`${ids}-until`}
        name="goodUntil"
        type="date"
        value={goodUntil}
        onChange={(event) => updateDraft({ goodUntil: event.target.value })}
        className="desk-input h-9 px-2 max-md:h-11 max-md:px-3"
      />
      <ConfirmSubmit
        title={`Bid ${money(offer)} for ${loanName}?`}
        consequence={`If the desk accepts it, you're committed to buy this loan at this price plus the buyer premium${deposit ? `, and a ${deposit[0]}% deposit is due within ${deposit[1]} day${deposit[1] === 1 ? "" : "s"}` : ""}.${bidTerms(diligenceDays)}${notices.length ? ` ${notices.join(" ")}` : ""}`}
        details={<ConfirmRows rows={[["Your bid", money(offer)], ["Buyer premium", money(premium)], ["All-in", money(offer + premium)], ...entityRows(entity, entities), ...credentialRows(credential?.line ?? null, room), goodUntilRow(goodUntil)]} />}
        confirmLabel="Place the bid"
        pendingLabel="Sending…"
        className="h-8 text-xs font-medium max-md:h-11 max-md:text-sm"
      >
        Bid loan
      </ConfirmSubmit>
      <Link href="/fees" className="text-xs text-link">See the fee schedule</Link>
    </form>
  );
}
