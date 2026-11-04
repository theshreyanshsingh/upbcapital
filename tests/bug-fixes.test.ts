import assert from "node:assert/strict";
import test from "node:test";
import { literal } from "../lib/db-filters";
import { mapPoint } from "../lib/enrichment";
import { deskDecisionAllowed } from "../lib/listing-status";
import { buyerPrice, openCounter, workingAmount } from "../lib/offers";
import { clientAddress } from "../lib/request-meta";
import { partyScope } from "../lib/screening";

const at = (iso: string) => new Date(`${iso}T12:00:00Z`);

test("only a price the buyer put forward can be awarded; a desk counter waits for the buyer", () => {
  const messages = [
    { kind: "OFFER", amount: 80000, createdAt: at("2026-11-01"), authorId: "buyer" },
    { kind: "COUNTER", amount: 100000, createdAt: at("2026-11-02"), authorId: "desk" },
  ];
  assert.equal(workingAmount(80000, messages), 100000);
  assert.equal(buyerPrice(80000, messages, "buyer"), 80000);
  assert.equal(openCounter(messages, "buyer"), 100000);
  const accepted = [...messages, { kind: "COUNTER", amount: 100000, createdAt: at("2026-11-03"), authorId: "buyer" }];
  assert.equal(buyerPrice(80000, accepted, "buyer"), 100000);
  assert.equal(openCounter(accepted, "buyer"), null);
  // Seeded offers with only an opening amount still award at that amount.
  assert.equal(buyerPrice(65000, [], "buyer"), 65000);
});

test("desk decisions apply only from the statuses they make sense in", () => {
  assert.equal(deskDecisionAllowed("APPROVE", "SUBMITTED"), true);
  assert.equal(deskDecisionAllowed("APPROVE", "SOLD"), false);
  assert.equal(deskDecisionAllowed("APPROVE", "PENDING"), false);
  assert.equal(deskDecisionAllowed("MARK_PENDING", "SUBMITTED"), false);
  assert.equal(deskDecisionAllowed("MARK_PENDING", "APPROVED"), true);
  assert.equal(deskDecisionAllowed("MARK_SOLD", "SOLD"), false);
  assert.equal(deskDecisionAllowed("REJECT", "PENDING"), false);
  assert.equal(deskDecisionAllowed("NOT_A_DECISION", "APPROVED"), false);
});

test("the client address is the one the nearest proxy added, not the one the caller wrote", () => {
  assert.equal(clientAddress("6.6.6.6, 203.0.113.9", null, 1), "203.0.113.9");
  assert.equal(clientAddress("6.6.6.6, 198.51.100.4, 203.0.113.9", null, 2), "198.51.100.4");
  assert.equal(clientAddress("203.0.113.9", null, 1), "203.0.113.9");
  assert.equal(clientAddress(null, "198.51.100.7", 1), "198.51.100.7");
  assert.equal(clientAddress(null, null, 1), "unknown");
});

test("search text is matched literally, so regex characters can't crash or widen a query", () => {
  assert.equal(literal("[(*"), "\\[\\(\\*");
  assert.equal(literal("a.b+c?"), "a\\.b\\+c\\?");
  assert.equal(literal("Smith & Co"), "Smith & Co");
});

test("map coordinates leave the server on a five-kilometre grid", () => {
  assert.deepEqual(mapPoint(25.761681, -80.191788), { latitude: 25.75, longitude: -80.2 });
  assert.deepEqual(mapPoint(null, -80.19), { latitude: null, longitude: null });
});

test("an OFAC decision belongs to one party, never to everyone who shares a name", () => {
  assert.deepEqual(partyScope({ userId: "u1", listingId: "l1" }), { userId: "u1" });
  assert.deepEqual(partyScope({ userId: null, listingId: "l1" }), { listingId: "l1" });
  assert.equal(partyScope({ userId: null, listingId: null }), null);
});
