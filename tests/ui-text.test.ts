import assert from "node:assert/strict";
import test from "node:test";
import { safeNoticeText } from "../lib/notice-text";

test("text from the address bar shows only as a plain sentence", () => {
  assert.equal(safeNoticeText("Sent to 12 buyers."), "Sent to 12 buyers.");
  assert.equal(safeNoticeText("Keep the deposit between 0% and 50%."), "Keep the deposit between 0% and 50%.");
  assert.equal(safeNoticeText("  Imported 4 filings ·   1 skipped.  "), "Imported 4 filings · 1 skipped.");
  assert.equal(safeNoticeText("Your account is locked. Call 305-555-0142 now."), null);
  assert.equal(safeNoticeText("Verify at https://upb-capital.example.com/login"), null);
  assert.equal(safeNoticeText("Reply to support@upb-help.example"), null);
  assert.equal(safeNoticeText("www.example.com has your refund"), null);
  assert.equal(safeNoticeText("x".repeat(301)), null);
  assert.equal(safeNoticeText("   "), null);
  // Dollar amounts and loan counts in the desk's own messages still pass.
  assert.equal(safeNoticeText("Sold at $1,436,900. Commission $43,107."), "Sold at $1,436,900. Commission $43,107.");
});
