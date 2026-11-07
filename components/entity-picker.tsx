"use client";

import { useCallback, useSyncExternalStore } from "react";
import { IRA_NOTE } from "@/lib/labels";

// The buying entities a bid can be for: the main file first, as the empty id, then each one the desk approved.
export type EntityOption = { id: string; name: string; kind: string; vestsAs: string; custodian: string | null };

// One choice per listing page, shared by the bid panel, buy it now and every loan box in the pool tape, so the
// buyer picks once and every bid on the page carries it.
const choices = new Map<string, string>();
const listeners = new Map<string, Set<() => void>>();

function subscribe(key: string, onChange: () => void) {
  let set = listeners.get(key);
  if (!set) listeners.set(key, (set = new Set()));
  set.add(onChange);
  return () => {
    set.delete(onChange);
  };
}

export function useEntityChoice(key: string, options: EntityOption[]) {
  const watch = useCallback((onChange: () => void) => subscribe(key, onChange), [key]);
  const id = useSyncExternalStore(watch, () => choices.get(key) ?? "", () => "");
  const choose = (value: string) => {
    choices.set(key, value);
    listeners.get(key)?.forEach((onChange) => onChange());
  };
  return [options.find((option) => option.id === id) ?? options[0] ?? null, choose] as const;
}

// What a bid confirmation restates about the entity. Nothing when the buyer has only their main file.
export function entityRows(chosen: EntityOption | null, options: EntityOption[]): [string, string][] {
  if (options.length < 2 || !chosen) return [];
  return [["Buying as", chosen.vestsAs], ...(chosen.custodian ? ([["Wires from", `${chosen.custodian}, the IRA custodian`]] as [string, string][]) : [])];
}

export function EntityField({ chosen }: { chosen: EntityOption | null }) {
  return <input type="hidden" name="buyerEntityId" value={chosen?.id ?? ""} />;
}

export function EntityPicker({ listingId, options }: { listingId: string; options: EntityOption[] }) {
  const [chosen, choose] = useEntityChoice(listingId, options);
  if (options.length < 2) return null;
  return (
    <div className="mt-3 space-y-2">
      <label className="block text-[13px] text-muted-foreground">
        Buying as
        <select value={chosen?.id ?? ""} onChange={(event) => choose(event.target.value)} className="desk-input mt-1 h-11">
          {options.map((option) => (
            <option key={option.id || "main"} value={option.id}>{option.name} · {option.kind}</option>
          ))}
        </select>
        <span className="mt-1 block text-xs">Every bid on this page is for this entity, loan bids included. The closing papers name it.</span>
      </label>
      {chosen?.custodian && <p className="rounded-lg border border-link/30 bg-link/5 px-3 py-2 text-xs leading-relaxed text-foreground">Vests as {chosen.vestsAs}. {IRA_NOTE}</p>}
    </div>
  );
}
