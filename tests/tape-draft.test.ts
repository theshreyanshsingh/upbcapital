import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "../lib/prisma";
import { deleteTapeDraft, purgeTapeDrafts, readTapeDraft, saveTapeDraft, tapeDraftCutoff, tapeDraftFresh } from "../lib/tape-draft";

test("a tape draft stays fresh for a day", () => {
  const now = new Date("2026-10-18T12:00:00Z");
  assert.equal(tapeDraftFresh(new Date("2026-10-18T11:00:00Z"), now), true);
  assert.equal(tapeDraftFresh(new Date("2026-10-17T12:00:00Z"), now), false);
  assert.equal(tapeDraftCutoff(now).toISOString(), "2026-10-17T12:00:00.000Z");
});

test("a tape draft is shared through the database and an abandoned one is purged", async () => {
  const email = `tape-draft-${crypto.randomUUID()}@example.com`;
  const user = await prisma.user.create({
    data: { email, name: "Tape draft", role: "INSTITUTIONAL_SELLER", accountStatus: "APPROVED", passwordHash: "x" },
  });
  const token = crypto.randomUUID();
  const csv = Buffer.from("city,state\nMiami,FL\n");
  try {
    await saveTapeDraft({ token, userId: user.id, filename: "book.csv", bytes: csv });
    const found = await readTapeDraft(user.id, token);
    assert.equal(found?.filename, "book.csv");
    assert.equal(found?.bytes.toString(), csv.toString());
    assert.equal(await readTapeDraft("not-this-user", token), null);

    const stale = crypto.randomUUID();
    await saveTapeDraft({ token: stale, userId: user.id, filename: "old.csv", bytes: Buffer.from("a") });
    await prisma.tapeDraft.update({ where: { token: stale }, data: { createdAt: new Date("2020-01-01T00:00:00Z") } });
    const removed = await purgeTapeDrafts(new Date("2026-10-18T12:00:00Z"));
    assert.ok(removed >= 1);
    assert.equal(await prisma.tapeDraft.findUnique({ where: { token: stale } }), null);
    assert.ok(await prisma.tapeDraft.findUnique({ where: { token } }));
    await deleteTapeDraft(token);
    assert.equal(await readTapeDraft(user.id, token), null);
  } finally {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
  }
});
