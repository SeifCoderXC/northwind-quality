import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gateNote, journeys, release } from "../src/catalog.js";
import { evaluate } from "../src/policy.js";

test("the Northwind train is blocked by checkout and payments", () => {
  const result = evaluate(journeys, [], Date.parse("2026-10-10T12:00:00Z"));
  assert.equal(result.decision, "blocked");
  assert.equal(result.impactUsers, 8_500_000);
  assert.equal(result.gates.find((gate) => gate.id === "flake").ok, true);
  assert.equal(result.gates.find((gate) => gate.id === "reach").ok, false);
  assert.deepEqual(
    result.services.map((row) => row.status),
    ["watch", "blocked", "blocked", "blocked"],
  );
});

test("the catalog size is not described as tests that ran", () => {
  const note = gateNote(release, journeys);
  assert.equal(journeys.length, 23);
  assert.match(note, /23 journeys are scored for this gate/);
  assert.match(note, /14,203 cases/);
  assert.match(note, /were not executed for this decision/);
  assert.doesNotMatch(note, /tests ran/);
  const page = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/public/app.js"), "utf8");
  assert.match(page, /gateNote/);
  assert.doesNotMatch(page, /tests ran/);
});
