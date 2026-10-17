import assert from "node:assert/strict";
import { test } from "node:test";
import { approveWaiver, evaluate, fileWaiver, flakeDetail, releaseBrief, waiverPrompt } from "../src/policy.js";

const now = Date.parse("2026-10-10T12:00:00Z");

const passed = (id) => ({
  id,
  serviceId: "identity",
  title: id,
  severity: "sev-2",
  status: "passed",
  critical: true,
  weeklyUsers: 1000,
});

const sev1 = {
  id: "pay",
  serviceId: "payments",
  title: "Charge answers",
  severity: "sev-1",
  status: "failed",
  critical: true,
  weeklyUsers: 2_100_000,
};

test("two unwaived critical failures block promotion and sum their reach", () => {
  const result = evaluate(
    [
      passed("ok"),
      { ...sev1 },
      {
        id: "cart",
        serviceId: "checkout",
        title: "Guest cart total",
        severity: "sev-1",
        status: "failed",
        critical: true,
        weeklyUsers: 2_400_000,
      },
    ],
    [],
    now,
  );
  assert.equal(result.decision, "blocked");
  assert.equal(result.reason, "2 journeys are blocking promotion.");
  assert.equal(result.impactUsers, 4_500_000);
  assert.equal(result.blocking.map((row) => row.id).sort().join(), "cart,pay");
  assert.equal(result.services.find((row) => row.id === "checkout").status, "blocked");
});

test("a non-critical failure does not block the train", () => {
  const result = evaluate(
    [
      passed("ok"),
      {
        id: "typo",
        serviceId: "search",
        title: "Typo tolerance",
        severity: "sev-3",
        status: "failed",
        critical: false,
        weeklyUsers: 50_000,
      },
    ],
    [],
    now,
  );
  assert.equal(result.decision, "canary");
  assert.equal(result.impactUsers, 0);
  assert.equal(result.services.find((row) => row.id === "search").status, "watch");
  assert.equal(result.reason, "Critical journeys are clear. Canary may advance. Stable stays in soak.");
});

test("a high-reach failure blocks even when it is not marked critical", () => {
  const result = evaluate(
    [
      passed("ok"),
      {
        id: "typo",
        serviceId: "search",
        title: "Typo tolerance",
        severity: "sev-3",
        status: "failed",
        critical: false,
        weeklyUsers: 4_000_000,
      },
    ],
    [],
    now,
  );
  assert.equal(result.decision, "blocked");
  assert.equal(result.impactUsers, 4_000_000);
  assert.equal(result.gates.find((gate) => gate.id === "reach").ok, false);
  assert.equal(result.services.find((row) => row.id === "search").status, "blocked");
});

test("exactly 5 percent flake does not block", () => {
  const rows = [
    ...Array.from({ length: 19 }, (_, index) => passed("p" + index)),
    { ...passed("flake"), status: "flaky" },
  ];
  const result = evaluate(rows, [], now);
  const gate = result.gates.find((gate) => gate.id === "flake");
  assert.equal(gate.ok, true);
  assert.equal(gate.detail, "1/20 · 5.000% · at the 5% limit");
  assert.equal(result.decision, "canary");
});

test("flake wording stays on the same side of 5 percent as the gate", () => {
  for (let scored = 1; scored <= 240; scored += 1) {
    for (let flaky = 0; flaky <= scored; flaky += 1) {
      const detail = flakeDetail(flaky, scored);
      const over = flaky * 100 > scored * 5;
      assert.equal(detail.includes("above the 5% limit"), over, detail);
      if (flaky * 100 === scored * 5) assert.match(detail, /at the 5% limit/);
      if (flaky * 100 < scored * 5) assert.match(detail, /within the 5% limit/);
    }
  }
  const overRounded = evaluate(
    [
      ...Array.from({ length: 189 }, (_, index) => passed("p" + index)),
      ...Array.from({ length: 10 }, (_, index) => ({ ...passed("f" + index), status: "flaky" })),
    ],
    [],
    now,
  );
  const overGate = overRounded.gates.find((gate) => gate.id === "flake");
  assert.equal(overGate.ok, false);
  assert.equal(overGate.detail, "10/199 · 5.025% · above the 5% limit");
  const underRounded = evaluate(
    [
      ...Array.from({ length: 191 }, (_, index) => passed("p" + index)),
      ...Array.from({ length: 10 }, (_, index) => ({ ...passed("f" + index), status: "flaky" })),
    ],
    [],
    now,
  );
  assert.equal(underRounded.gates.find((gate) => gate.id === "flake").detail, "10/201 · 4.975% · within the 5% limit");
});

test("a high-reach waiver waits for a director and cannot last 72 hours", () => {
  const journey = {
    id: "typo",
    serviceId: "search",
    title: "Typo tolerance",
    severity: "sev-3",
    status: "failed",
    critical: false,
    weeklyUsers: 4_000_000,
  };
  assert.equal(fileWaiver(journey, { reason: "x".repeat(40), hours: 72, actor: "Nora Hale" }, now).ok, false);
  const filed = fileWaiver(journey, { reason: "x".repeat(40), hours: 24, actor: "Nora Hale" }, now);
  assert.equal(filed.waiver.status, "pending");
  assert.equal(evaluate([passed("ok"), journey], [filed.waiver], now + 1000).decision, "blocked");
  const approved = approveWaiver(filed.waiver, "L. Okonkwo", now + 1000);
  assert.equal(evaluate([passed("ok"), journey], [approved.waiver], now + 1000).decision, "canary");
});

test("a small non-critical waiver is approved by the captain", () => {
  const journey = {
    id: "hint",
    severity: "sev-3",
    status: "failed",
    critical: false,
    weeklyUsers: 50_000,
  };
  const filed = fileWaiver(journey, { reason: "Known gap in suggestions.", hours: 72, actor: "Nora Hale" }, now);
  assert.equal(filed.ok, true);
  assert.equal(filed.waiver.status, "approved");
});

test("the release brief names the decision and each blocker", () => {
  const text = releaseBrief({
    releaseId: "2026.10.2",
    decision: "blocked",
    reason: "2 journeys are blocking promotion.",
    impactUsers: 4_500_000,
    blocking: [{ severity: "sev-1", title: "Guest cart total", serviceId: "checkout", weeklyUsers: 2_400_000 }],
  });
  assert.match(text, /Release 2026\.10\.2/);
  assert.match(text, /Decision: blocked/);
  assert.match(text, /Guest cart total/);
  assert.match(text, /2400000/);
});

test("a sev-1 waiver needs forty characters and at most 24 hours", () => {
  assert.equal(fileWaiver(sev1, { reason: "provider blip", hours: 4, actor: "A. Rahman" }, now).ok, false);
  assert.equal(fileWaiver(sev1, { reason: "x".repeat(40), hours: 72, actor: "A. Rahman" }, now).ok, false);
  const filed = fileWaiver(
    sev1,
    { reason: "Processor timeout is outside our change. Cap is 24 hours.", hours: 24, actor: "A. Rahman" },
    now,
  );
  assert.equal(filed.ok, true);
  assert.equal(filed.waiver.status, "pending");
  const waiting = evaluate([passed("ok"), sev1], [filed.waiver], now + 1000);
  assert.equal(waiting.decision, "blocked");
  assert.equal(approveWaiver(filed.waiver, "A. Rahman", now + 1000).ok, false);
  const approved = approveWaiver(filed.waiver, "L. Okonkwo", now + 1000);
  assert.equal(approved.ok, true);
  const cleared = evaluate([passed("ok"), sev1], [approved.waiver], now + 1000);
  assert.equal(cleared.decision, "canary");
  const expired = evaluate([passed("ok"), sev1], [filed.waiver], now + 25 * 60 * 60 * 1000);
  assert.equal(expired.decision, "blocked");
});

test("flake rate above 5 percent blocks a green critical set", () => {
  const rows = [...Array.from({ length: 10 }, (_, index) => passed("p" + index)), { ...passed("flake"), status: "flaky" }];
  const result = evaluate(rows, [], now);
  assert.equal(result.decision, "blocked");
  assert.equal(result.gates.find((gate) => gate.id === "flake").ok, false);
  assert.equal(result.reason, "Flake rate is above 5%.");
});

test("a clear canary leaves stable regions in soak or held", () => {
  const result = evaluate([passed("ok")], [], now);
  assert.deepEqual(
    result.rollout.map((row) => row.state),
    ["eligible", "soak", "held"],
  );
});

test("high reach names non-sev-1 failures and every blocker over 1M sessions", () => {
  const sevOnly = evaluate([passed("ok"), { ...sev1 }], [], now);
  const sevDetail = sevOnly.gates.find((gate) => gate.id === "reach").detail;
  assert.equal(sevDetail.includes("No failure over 1M"), false);
  assert.match(sevDetail, /No non-sev-1 failure over 1M sessions/);
  assert.match(sevDetail, /1 blocking journey is over 1M sessions/);

  const mixed = evaluate(
    [
      passed("ok"),
      { ...sev1 },
      {
        id: "cart",
        serviceId: "checkout",
        title: "Guest cart total",
        severity: "sev-1",
        status: "failed",
        critical: true,
        weeklyUsers: 2_400_000,
      },
      { ...passed("known-sku"), id: "known-sku", serviceId: "search", title: "Search finds a known SKU" },
      {
        id: "typo",
        serviceId: "search",
        title: "Typo tolerance",
        severity: "sev-3",
        status: "failed",
        critical: false,
        weeklyUsers: 4_000_000,
      },
    ],
    [],
    now,
  );
  const detail = mixed.gates.find((gate) => gate.id === "reach").detail;
  assert.match(detail, /1 non-sev-1 failure over 1M sessions/);
  assert.match(detail, /3 blocking journeys are over 1M sessions/);
  assert.equal(mixed.services.find((row) => row.id === "search").criticalPass, "100.0% · excludes Typo tolerance");
});

test("a director cannot approve their own million-session waiver", () => {
  const journey = {
    id: "typo",
    severity: "sev-3",
    status: "failed",
    critical: false,
    weeklyUsers: 4_000_000,
  };
  const filed = fileWaiver(journey, { reason: "x".repeat(40), hours: 24, actor: "L. Okonkwo" }, now);
  const refused = approveWaiver(filed.waiver, "L. Okonkwo", now + 1000);
  assert.equal(refused.ok, false);
  assert.equal(refused.error, "A different director has to approve this waiver.");
});

test("the waiver prompt says a different director must approve sev-1 and million-session failures", () => {
  assert.match(waiverPrompt(sev1), /different director/);
  assert.match(waiverPrompt(sev1), /24 hours/);
  assert.match(
    waiverPrompt({ id: "typo", severity: "sev-3", critical: false, weeklyUsers: 4_000_000 }),
    /different director/,
  );
  assert.match(
    waiverPrompt({ id: "hint", severity: "sev-3", critical: false, weeklyUsers: 50_000 }),
    /captain can approve/,
  );
});
