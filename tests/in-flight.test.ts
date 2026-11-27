import assert from "node:assert/strict";
import test from "node:test";
import { joinInFlight } from "../lib/in-flight";
import { flushHits, recordHit } from "../lib/hits";
import { prisma } from "../lib/prisma";

test.after(async () => {
  await prisma.$disconnect();
});

// A read that waits until the test lets it go, numbered by how many reads have started.
function gatedReads() {
  const gates: (() => void)[] = [];
  let started = 0;
  const read = () => {
    started += 1;
    const n = started;
    return new Promise<number>((resolve) => gates.push(() => resolve(n)));
  };
  return { read, started: () => started, open: () => gates.splice(0).forEach((go) => go()) };
}

test("callers at the same moment share one read, and a caller after it has finished reads again", async () => {
  const reads = gatedReads();
  const together = [joinInFlight("same moment", reads.read), joinInFlight("same moment", reads.read), joinInFlight("same moment", reads.read)];
  assert.equal(reads.started(), 1);
  reads.open();
  assert.deepEqual(await Promise.all(together), [1, 1, 1]);
  const later = joinInFlight("same moment", reads.read);
  assert.equal(reads.started(), 2, "a finished read is never handed out again");
  reads.open();
  assert.equal(await later, 2);
});

test("different reads never share", async () => {
  const reads = gatedReads();
  const both = Promise.all([joinInFlight("first", reads.read), joinInFlight("second", reads.read)]);
  assert.equal(reads.started(), 2);
  reads.open();
  assert.deepEqual(await both, [1, 2]);
});

test("a failed read fails everyone who joined it, and the next caller reads again", async () => {
  let calls = 0;
  const failing = async () => {
    calls += 1;
    throw new Error("Atlas went away");
  };
  const joined = [joinInFlight("failing", failing), joinInFlight("failing", failing)];
  for (const outcome of await Promise.allSettled(joined)) assert.equal(outcome.status, "rejected");
  assert.equal(calls, 1);
  assert.equal(await joinInFlight("failing", async () => "back"), "back");
});

test("visits are written together, a batch at a time, each with the time it came in", async () => {
  const path = `/in-flight-test-${Date.now()}`;
  const before = Date.now();
  await recordHit(path);
  await recordHit(path);
  await recordHit(path);
  assert.equal(await prisma.pageHit.count({ where: { path } }), 0, "held until the batch goes");
  await flushHits();
  const rows = await prisma.pageHit.findMany({ where: { path } });
  assert.equal(rows.length, 3);
  for (const row of rows) assert.ok(row.createdAt.getTime() >= before && row.createdAt.getTime() <= Date.now());
  await flushHits();
  assert.equal(await prisma.pageHit.count({ where: { path } }), 3, "nothing is written twice");
  await prisma.pageHit.deleteMany({ where: { path } });
});
