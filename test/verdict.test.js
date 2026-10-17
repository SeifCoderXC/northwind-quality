import assert from "node:assert/strict";
import { test } from "node:test";
import { applyTriage, decide } from "../src/verdict.js";

const row = (id, status, classification = null) => ({ id, status, classification, note: "" });

test("an unclassified failure holds the release", () => {
  const verdict = decide([row("cart", "failed")]);
  assert.equal(verdict.decision, "hold");
  assert.equal(verdict.reason, "1 failure needs a class");
});

test("a product bug holds the release when the other failure is waived", () => {
  const verdict = decide([
    row("cart", "failed", "product_bug"),
    row("pay", "failed", "environment"),
  ]);
  assert.equal(verdict.decision, "hold");
  assert.equal(verdict.reason, "1 product bug is open");
});

test("waived failures, flakes, and skips do not block", () => {
  const verdict = decide([
    row("pay", "failed", "environment"),
    row("label", "failed", "test_bug"),
    row("retry", "flaky"),
    row("later", "skipped"),
    row("ok", "passed"),
  ]);
  assert.equal(verdict.decision, "ship");
  assert.equal(verdict.reason, "Nothing is blocking the release");
});

test("a run with no tests holds", () => {
  const verdict = decide([]);
  assert.equal(verdict.decision, "hold");
  assert.equal(verdict.reason, "This run has no tests");
});

test("a saved class and note replace the empty ones", () => {
  const [testRow] = applyTriage([row("cart", "failed")], {
    cart: { classification: "environment", note: "  Payment provider timed out  " },
  });
  assert.equal(testRow.classification, "environment");
  assert.equal(testRow.note, "Payment provider timed out");
});

test("an unknown class is ignored", () => {
  const [testRow] = applyTriage([row("cart", "failed", "product_bug")], {
    cart: { classification: "nope", note: "   " },
  });
  assert.equal(testRow.classification, "product_bug");
  assert.equal(testRow.note, "");
});
