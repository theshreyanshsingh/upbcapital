import assert from "node:assert/strict";
import test from "node:test";
import type { Note } from "@prisma/client";
import { loanFacts } from "../lib/buyer-api";
import { LOAN_FIELDS } from "../lib/loan-file";
import { selfServiced, servicerShown } from "../lib/seller-anonymity";

const bank = { sellerId: "s1", brokerId: null, clientSellerName: null, seller: { role: "INSTITUTIONAL_SELLER", name: "Dana Reyes", companyName: "First Community Credit Union", companyType: "CREDIT_UNION" } };

test("a seller servicing its own loans reads as its type until its name shows", () => {
  assert.equal(selfServiced(bank, "First Community CU"), true);
  assert.equal(selfServiced(bank, "FIRST COMMUNITY CREDIT UNION, INC."), true);
  assert.equal(selfServiced(bank, "Shellpoint Mortgage Servicing"), false);
  assert.equal(selfServiced(bank, ""), false);
  assert.equal(servicerShown(bank, "First Community CU", false), "Credit union (services its own loans)");
  assert.equal(servicerShown(bank, "First Community CU", true), "First Community CU");
  assert.equal(servicerShown(bank, "Shellpoint Mortgage Servicing", false), "Shellpoint Mortgage Servicing");
  // The desk's own paper names no seller to hide.
  assert.equal(selfServiced({ ...bank, seller: { ...bank.seller, role: "ADMIN" } }, "First Community CU"), false);
});

test("MERS Org IDs follow the loan's access rule and stay out of the buyer API", () => {
  const facts = loanFacts({ id: "n1", city: "Ames", state: "IA", tradeStatus: "AVAILABLE", askingPrice: 1, avmValue: null, avmProvider: "", eRegistryController: "1234567", eRegistryLocation: "7654321", servicerName: "Shellpoint" } as unknown as Note);
  for (const field of ["eRegistryController", "eRegistryLocation"]) {
    assert.equal(LOAN_FIELDS.find((spec) => spec.field === field)?.identity, true, field);
    assert.equal(field in facts, false, field);
  }
  assert.equal(facts.servicerName, "Shellpoint");
});
